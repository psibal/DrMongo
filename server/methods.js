Meteor.methods({
  createCollection(databaseId, collectionName) {
    let database = Databases.findOne(databaseId);
    MongoHelpers.createCollection(database, collectionName);

    // update DR cache
    return Collections.insert({
      database_id: databaseId,
      name: collectionName,
      updatedAt: new Date,
      keep: true
    });
  },

  updateAllConnectionsStructure() {
    Connections.find({}).forEach(function(connection) {
      Meteor.call('updateConnectionStructure', connection._id);
    })
  },

  updateConnectionStructure(connectionId) {
    let connection = Connections.findOne(connectionId);
    if (!connection) return false;
    let databases = MongoHelpers.getDatabases(connection);
    if (!databases) return false;

    Databases.update({connection_id: connectionId}, {$set: {keep: false}}, {multi: true});
    _.map(databases, (databaseName) => {
      Databases.upsert(
        {connection_id: connectionId, name: databaseName},
        {
          $set: {
            updatedAt: new Date,
            keep: true
          }
        }
      );

      let database = Databases.findOne({
        connection_id: connectionId,
        name: databaseName
      });

      Collections.update({database_id: database._id}, {$set: {keep: false}}, {multi: true});
      let collections = MongoHelpers.getCollections(connection, databaseName);
      if (collections === false) return false;

      _.map(collections, (collectionName) => {
        Collections.upsert(
          {database_id: database._id, name: collectionName},
          {
            $set: {
              updatedAt: new Date,
              keep: true
            }
          }
        );
      });
      Collections.remove({database_id: database._id, keep: false});

    });
    Databases.remove({connection_id: connectionId, keep: false});
    return true;
  },

  findCollectionForDocumentId(databaseId, documentId) {
    check(databaseId, String);
    check(documentId, Match.OneOf(String, ObjectId));

    var db = MongoHelpers.connectDatabase(databaseId);

    let foundCollection = null;

    let selector = {_id: objectifyMongoId(documentId)};

    let collectionNamesWrapper = Meteor.wrapAsync((cb) => {
      db.listCollections().toArray((error, response) => {
        cb(error, response);
      })
    });
    let collections = collectionNamesWrapper(); // todo fetch collection from DRM db ?

    var c;
    let collectionFindWrapper = Meteor.wrapAsync((cb) => {
      c.findOne(selector, (error, doc) => {
        cb(error, doc);
      })
    });

    _.map(collections, function(collection) {
      if (foundCollection) return false;

      c = db.collection(collection.name);

      let result = collectionFindWrapper(); // todo refactor this magic parameter passing
      if (result) foundCollection = collection.name;
    });

    db.close();
    return foundCollection;
  },

  getDocuments(collectionId, filter, page) {
    page = page || 1;

    let collectionInfo = Collections.findOne(collectionId);
    if (!collectionInfo) return false;
    let db = MongoHelpers.connectDatabase(collectionInfo.database_id);
    let collection = db.collection(collectionInfo.name);

    let settings = new CurrentSettings();
    collectionInfo.paginationLimit = parseInt(collectionInfo.paginationLimit || settings.global.documentsPerPage);

    let selector, options;

    if (resemblesId(filter)) {
      selector = {_id: objectifyMongoId(filter)};
      options = {};
    } else {
      try {
        filter = eval('([' + filter + '])');
      }

      catch(error) {
        return false;
      }

      selector = filter[0] || {};
      options = filter[1] || {};
    }

    let collectionCountWrapper = Meteor.wrapAsync((cb) => {
      collection.find(selector, options).count((error, response) => {
        cb(error, response);
      })
    });

    let docsCount = collectionCountWrapper();

    if (!options.skip) {
      options.skip = (page - 1) * collectionInfo.paginationLimit;
    }

    if (!options.limit) {
      options.limit = collectionInfo.paginationLimit;
    }

    let docs = collection
      .find(selector, options.fields || {})
      .sort(options.sort || {})
      .skip(options.skip || 0)
      .limit(options.limit || 0);

    let collectionToArrayWrapper = Meteor.wrapAsync((cb) => {
      docs.toArray((error, response) => {
        cb(error, response);
      })
    });

    docs = collectionToArrayWrapper();


    var index = options.skip + 1;
    docs.map(item => {
      if(typeof item._id == 'object' && item._id._bsontype == 'ObjectID') {
        item._id = new ObjectId(item._id.toString());
      }

      item[DRM.documentIndex] = index++;
    });

    db.close();

    log('> total count: ' + docsCount);
    return {
      docs: docs,
      count: docsCount // @TODO rename this to 'totalCount'
    }
  },

  insertDocument(collectionId, data) {
    let collection = Collections.findOne(collectionId);
    let database = collection.database();

    var db = MongoHelpers.connectDatabase(database._id);
    var dbCollection = db.collection(collection.name);

    let insertWrapper = Meteor.wrapAsync((cb) => {
      dbCollection.insert(data, (error, response) => {
        cb(error, response);
      });
    });

    try {
      var insertResult = insertWrapper();
      db.close();
      return insertResult;
    }
    catch(error) {
      log(error)
      db.close();
      return false;
    }
  },

  updateDocument(collectionId, documentId, data) {
    // log(collectionId, documentId, data);
    let collection = Collections.findOne(collectionId);
    let database = collection.database();

    var db = MongoHelpers.connectDatabase(database._id);
    var dbCollection = db.collection(collection.name);

    delete data._id;

    let updateWrapper = Meteor.wrapAsync((cb) => {
      dbCollection.update({_id: objectifyMongoId(documentId)}, data, (error, response) => {
        cb(error, response);
      });
    });

    let updatedCount = updateWrapper();
    db.close();

    return updatedCount;
  },

  removeDocument(collectionId, documentId) {
    let collection = Collections.findOne(collectionId);
    let database = collection.database();

    var db = MongoHelpers.connectDatabase(database._id);
    var dbCollection = db.collection(collection.name);

    let deleteWrapper = Meteor.wrapAsync((cb) => {
      dbCollection.findAndRemove({_id: objectifyMongoId(documentId)}, (error, response) => {
        if(!error && !response) {
          error = new Meteor.Error('Document ' + getId(documentId) + ' not found');
        }

        cb(error, response);
      });
    });

    let result = deleteWrapper();
    log('result', result);
    db.close();

    return result;
  },

  dropAllDocuments(collectionId) {
    let collection = Collections.findOne(collectionId);
    let database = collection.database();

    var db = MongoHelpers.connectDatabase(database._id);
    var dbCollection = db.collection(collection.name);

    let wrapper = Meteor.wrapAsync((cb) => {
      dbCollection.remove({}, (error, response) => {
        cb(error, response);
      });
    });

    let result = wrapper();
    db.close();

    return result;
  }
});
