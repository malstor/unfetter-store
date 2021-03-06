const lodash = require('lodash');
const stix = require('../../helpers/stix');
const jsonApiConverter = require('../../helpers/json_api_converter');
const parser = require('../../helpers/url_parser');
const modelFactory = require('./modelFactory');
const publish = require('./publish');
const DataHelper = require('../../helpers/extended_data_helper');
const SecurityHelper = require('../../helpers/security_helper');
const config = require('../../config/config');

const apiRoot = config.apiRoot;

module.exports = class BaseController {
    constructor(type) {
        this.type = type;
        this.model = modelFactory.getModel(type);
    }

    aggregate() {
        const type = this.type;
        const model = this.model;
        return (req, res) => {
            res.header('Content-Type', 'application/vnd.api+json');

            const query = parser.dbQueryParams(req);
            if (query.error) {
                return res.status(400).json({
                    errors: [{
                        status: 400, source: '', title: 'Error', code: '', detail: query.error
                    }]
                });
            }

            model
                .aggregate(query.aggregations)
                .exec((err, result) => {
                    if (err) {
                        return res.status(500).json({
                            errors: [{
                                status: 500, source: '', title: 'Error', code: '', detail: 'An unknown error has occurred.'
                            }]
                        });
                    }

                    const requestedUrl = apiRoot + req.originalUrl;
                    const convertedResult = jsonApiConverter.convertJsonToJsonApi(result, type, requestedUrl);
                    return res.status(200).json({ links: { self: requestedUrl, }, data: convertedResult });
                });
        };
    }

    get() {
        return this.getCb((err, convertedResult, requestedUrl, req, res) => res.status(200).json({ links: { self: requestedUrl, }, data: convertedResult }));
    }

    getCb(callback) {
        const type = this.type;
        const model = this.model;
        return (req, res) => {
            res.header('Content-Type', 'application/vnd.api+json');

            const query = parser.dbQueryParams(req);
            if (query.error) {
                return res.status(400).json({
                    errors: [{
                        status: 400, source: '', title: 'Error', code: '', detail: query.error
                    }]
                });
            }


            const matcherQuery = this.applySecurityFilterWhenNeeded(Object.assign({ 'stix.type': type }, query.filter), type, req.user);
            model
                .find(matcherQuery)
                .sort(query.sort)
                .limit(query.limit)
                .skip(query.skip)
                .select(query.project)
                .exec((err, result) => {
                    if (err) {
                        return res.status(500).json({
                            errors: [{
                                status: 500, source: '', title: 'Error', code: '', detail: 'An unknown error has occurred.'
                            }]
                        });
                    }

                    const requestedUrl = apiRoot + req.originalUrl;
                    const data = DataHelper.getEnhancedData(result, req.swagger.params);
                    const convertedResult = jsonApiConverter.convertJsonToJsonApi(data, type, requestedUrl);
                    // return res.status(200).json({ links: { self: requestedUrl, }, data: convertedResult });
                    callback(err, convertedResult, requestedUrl, req, res);
                });
        };
    }

    getById() {
        const type = this.type;
        return this.getByIdCb((err, result, req, res, id) => {
            if (err) {
                return res.status(500).json({
                    errors: [{
                        status: 500, source: '', title: 'Error', code: '', detail: 'An unknown error has occurred.'
                    }]
                });
            }

            if (result && result.length === 1) {
                const requestedUrl = apiRoot + req.originalUrl;
                const data = DataHelper.getEnhancedData(result, req.swagger.params);
                const convertedResult = jsonApiConverter.convertJsonToJsonApi(data[0], type, requestedUrl);
                return res.status(200).json({ links: { self: requestedUrl, }, data: convertedResult });
            }

            return res.status(404).json({ message: `No item found with id ${id}` });
        });
    }

    getByIdCb(callback) {
        const type = this.type;
        const model = this.model;
        return (req, res) => {
            res.header('Content-Type', 'application/vnd.api+json');
            const id = req.swagger.params.id ? req.swagger.params.id.value : '';
            // get the most recent one since there could be many with the same id
            // stix most recent is defined as the most recently modified one
            const query = this.applySecurityFilterWhenNeeded({ _id: id }, type, req.user);
            model
                .find(query)
                .sort({ modified: '-1' })
                .limit(1)
                .exec((err, result) => {
                    callback(err, result, req, res, id);
                });
        };
    }

    add() {
        const type = this.type;
        const model = this.model;
        const relationshipModel = modelFactory.getModel('relationship');
        const identityModel = modelFactory.getModel('identity');

        return (req, res) => {
            res.header('Content-Type', 'application/vnd.api+json');
            const obj = {};

            if (req.swagger.params.data !== undefined && req.swagger.params.data.value.data.attributes !== undefined) {
                const data = req.swagger.params.data.value.data;
                const relationships = [];
                let relatedIds;

                obj.stix = data.attributes;
                if (data.type !== undefined) {
                    obj.stix.type = data.type;
                } else {
                    obj.stix.type = this.type;
                }
                obj.stix.id = stix.id(obj.stix.type);

                // Process extended properties
                const extendedProperties = {};
                for (const prop of Object.keys(data.attributes)) {
                    if (prop.match(/^x_/) !== null) {
                        extendedProperties[prop] = data.attributes[prop];
                        delete obj.stix[prop];
                    }
                }
                if (Object.keys(extendedProperties).length > 0) {
                    obj.extendedProperties = extendedProperties;
                }

                if (obj.stix.metaProperties !== undefined) {
                    if (obj.stix.metaProperties.relationships !== undefined) {
                        relatedIds = obj.stix.metaProperties.relationships;
                        delete obj.stix.metaProperties.relationships;
                    }
                    const tempMeta = obj.stix.metaProperties;
                    delete obj.stix.metaProperties;
                    obj.metaProperties = tempMeta;
                }

                // If using UAC, confirm user can post to that group
                if (process.env.RUN_MODE === 'UAC' && req.user && req.user.role !== 'ADMIN' && obj.stix.created_by_ref) {
                    const userOrgIds = req.user.organizations
                        .filter(org => org.approved)
                        .map(org => org.id);


                    if (!userOrgIds.includes(obj.stix.created_by_ref)) {
                        console.log(req.user.userName, 'attempted to add a STIX message to a organization he/she does not belong to');
                        return res.status(500).json({
                            errors: [{
                                status: 401, source: '', title: 'Error', code: '', detail: 'User is not allowed to create a STIX for this organization.'
                            }]
                        });
                    }
                }

                // Add Unfetter userId as creator if present
                if (req.user && req.user._id) {
                    obj.creator = req.user._id;
                }

                const newDocument = new model(obj);

                const error = newDocument.validateSync();
                if (error) {
                    const errors = [];
                    lodash.forEach(error.errors, field => {
                        errors.push(field.message);
                    });
                    return res.status(400).json({
                        errors: [{
                            status: 400, source: '', title: 'Error', code: '', detail: errors
                        }]
                    });
                }

                newDocument._id = newDocument.stix.id;

                if (relatedIds) {
                    for (const relatedId of relatedIds) {
                        const relId = stix.id('relationship');
                        let relType = '';
                        // TODO make this better
                        switch (type) {
                            case 'indicator':
                                relType = 'indicates';
                                break;
                            case 'x-unfetter-sensor':
                                relType = 'detects';
                                break;
                            default:
                        }
                        const tempRelationship = {
                            stix: {
                                id: relId,
                                source_ref: newDocument.stix.id,
                                target_ref: relatedId,
                                relationship_type: relType,
                                created_by_ref: obj.stix.created_by_ref
                            }
                        };

                        const newRelationshipDocument = new relationshipModel(tempRelationship);
                        const relationshipErrors = newRelationshipDocument.validateSync();
                        if (relationshipErrors) {
                            console.log('Error attempting to synchronize a relationship obj', relationshipErrors);
                        } else {
                            newRelationshipDocument._id = newRelationshipDocument.stix.id;
                            relationships.push(newRelationshipDocument);
                        }
                    }
                }

                if (relationships.length) {
                    relationshipModel.insertMany(relationships, (err, results) => {
                        if (err) {
                            console.log('Error while creating relationships for ', newDocument._id, ': ', err);
                        } else {
                            console.log('Successfully created ', results.length, ' relationships for: ', newDocument._id);
                        }
                    });
                }

                model.create(newDocument, (err, result) => {
                    if (err) {
                        console.log(err);
                        return res.status(500).json({
                            errors: [{
                                status: 500, source: '', title: 'Error', code: '', detail: 'An unknown error has occurred.'
                            }]
                        });
                    }

                    // Socket handling
                    if (process.env.RUN_MODE !== 'DEMO') {
                        // Notify org members
                        if (req.user && req.user._id && obj.stix.created_by_ref) {
                            identityModel.findById(obj.stix.created_by_ref, (identityErr, identityResult) => {
                                if (identityErr || !identityResult) {
                                    console.log('Unable to find identity, cannot publish to organization');
                                } else {
                                    const identityObj = identityResult.toObject();
                                    if (obj.stix.type === 'indicator') {
                                        publish.notifyOrg(req.user._id, obj.stix.created_by_ref, 'STIX', `New STIX by ${identityObj.stix.name}`, `New ${newDocument.stix.type}: ${newDocument.stix.name}`, `/indicator-sharing/single/${newDocument._id}`);
                                    } else if (obj.stix.type === 'relationship') {
                                        console.log(`Skipping notification for relationship object ${newDocument._id}`);
                                    } else {
                                        publish.notifyOrg(req.user._id, obj.stix.created_by_ref, 'STIX', `New STIX by ${identityObj.stix.name}`, `New ${newDocument.stix.type}: ${newDocument.stix.name}`);
                                    }
                                }
                            });
                        }

                        // Send new STIX id to add
                        publish.sendStixId(newDocument._id, newDocument.stix.type);
                    }

                    const requestedUrl = apiRoot + req.originalUrl;
                    const resObj = result.toObject();
                    let returnObj = { ...resObj.stix };

                    if (resObj.extendedProperties) {
                        returnObj = { ...returnObj, ...resObj.extendedProperties };
                    }

                    if (resObj.metaProperties) {
                        returnObj.metaProperties = resObj.metaProperties;
                    }

                    const convertedResult = jsonApiConverter.convertJsonToJsonApi([
                        returnObj
                    ], type, requestedUrl);

                    return res.status(201).json({ links: { self: requestedUrl, }, data: convertedResult });
                });
            } else {
                return res.status(400).json({
                    errors: [{
                        status: 400, source: '', title: 'Error', code: '', detail: 'malformed request'
                    }]
                });
            }
        };
    }

    update() {
        const type = this.type;
        const model = this.model;
        const relationshipModel = modelFactory.getModel('relationship');
        const attachmentFilesModel = modelFactory.getModel('attachmentfiles');
        const attachmentChunksModel = modelFactory.getModel('attachmentchunks');
        const ObjectID = require('mongoose').mongo.ObjectID;

        return (req, res) => {
            res.header('Content-Type', 'application/vnd.api+json');

            // get the old item
            if (req.swagger.params.id.value !== undefined && req.swagger.params.data !== undefined && req.swagger.params.data.value.data.attributes !== undefined) {
                const id = req.swagger.params.id ? req.swagger.params.id.value : '';
                const relationshipsToAdd = [];
                const relationshipsIdsToDelete = [];
                let relatedIds;
                let existingAttachments;
                let incomingAttachments;

                const query = this.applySecurityFilterWhenNeeded({ _id: id }, type, req.user, false);
                model.findById(query, (err, result) => {
                    if (err) {
                        return res.status(500).json({
                            errors: [{
                                status: 500, source: '', title: 'Error', code: '', detail: 'An unknown error has occurred.'
                            }]
                        });
                    } else if (!result) {
                        return res.status(404).json({ message: 'Unable to retrieve document' });
                    }

                    // set the new values
                    const resultObj = result.toObject();
                    const incomingObj = req.swagger.params.data ? req.swagger.params.data.value.data.attributes : {};

                    if (resultObj.metaProperties && resultObj.metaProperties.attachments && resultObj.metaProperties.attachments.length) {
                        existingAttachments = resultObj.metaProperties.attachments;
                    }

                    const has = Object.prototype.hasOwnProperty;
                    for (const key in incomingObj) {
                        if (has.call(incomingObj, key)) {
                            if (key === 'metaProperties') {
                                for (const metaKey in incomingObj.metaProperties) {
                                    if (has.call(incomingObj.metaProperties, metaKey)) {
                                        if (resultObj.metaProperties === undefined) {
                                            resultObj.metaProperties = {};
                                        }
                                        resultObj.metaProperties[metaKey] = incomingObj.metaProperties[metaKey];
                                    }
                                }
                            } else if (key.match(/^x_/) === null && has.call(incomingObj, key)) {
                                resultObj.stix[key] = incomingObj[key];
                            } else if (key.match(/^x_/) !== null && has.call(incomingObj, key)) {
                                if (resultObj.extendedProperties === undefined) {
                                    resultObj.extendedProperties = {};
                                }
                                resultObj.extendedProperties[key] = incomingObj[key];
                            }
                        }
                    }

                    if (resultObj.metaProperties !== undefined) {
                        if (resultObj.metaProperties.relationships !== undefined) {
                            relatedIds = resultObj.metaProperties.relationships;
                            delete resultObj.metaProperties.relationships;
                        }
                        if (resultObj.metaProperties.attachments && resultObj.metaProperties.attachments.length) {
                            incomingAttachments = resultObj.metaProperties.attachments;
                        }

                        const tempMeta = resultObj.metaProperties;
                        delete resultObj.metaProperties;
                        resultObj.metaProperties = tempMeta;
                    }

                    // then validate
                    // guard
                    resultObj.stix.modified = new Date();
                    const newDocument = new model(resultObj);
                    const error = newDocument.validateSync();
                    if (error) {
                        const errors = [];
                        lodash.forEach(error.errors, field => {
                            errors.push(field.message);
                        });
                        return res.status(400).json({
                            errors: [{
                                status: 400, source: '', title: 'Error', code: '', detail: errors
                            }]
                        });
                    }

                    if (relatedIds && relatedIds.length) {
                        relationshipModel.find({ 'stix.source_ref': resultObj._id }, (relErr, relResults) => {
                            if (relErr) {
                                console.log(`Unable to find related objects for: ${resultObj._id}`);
                            } else {
                                const existingRelObjs = relResults
                                    .map(doc => doc.toObject());

                                // Add relationships for objs that do not already exist
                                relatedIds.forEach(relId => {
                                    if (!existingRelObjs.map(relObj => relObj.stix.target_ref).includes(relId)) {
                                        const newId = stix.id('relationship');
                                        let relType = '';
                                        // TODO make this better
                                        switch (resultObj.stix.type) {
                                        case 'indicator':
                                            relType = 'indicates';
                                            break;
                                        case 'x-unfetter-sensor':
                                            relType = 'detects';
                                            break;
                                        default:
                                        }
                                        const tempRelationship = {
                                            stix: {
                                                id: newId,
                                                source_ref: resultObj._id,
                                                target_ref: relId,
                                                relationship_type: relType,
                                                created_by_ref: resultObj.stix.created_by_ref
                                            }
                                        };

                                        const newRelationshipDocument = new relationshipModel(tempRelationship);
                                        const relationshipErrors = newRelationshipDocument.validateSync();
                                        if (relationshipErrors) {
                                            console.log('Error attempting to synchronize a relationship obj', relationshipErrors);
                                        } else {
                                            newRelationshipDocument._id = newRelationshipDocument.stix.id;
                                            relationshipsToAdd.push(newRelationshipDocument);
                                        }
                                    }
                                });

                                // Delete relationships that were removed
                                existingRelObjs.forEach(existingRelObj => {
                                    if (!relatedIds.includes(existingRelObj.stix.target_ref)) {
                                        relationshipsIdsToDelete.push(existingRelObj._id);
                                    }
                                });

                                if (relationshipsToAdd.length) {
                                    relationshipModel.insertMany(relationshipsToAdd, (addRelErr, addRelResults) => {
                                        if (addRelErr) {
                                            console.log('Error while creating relationships for ', newDocument._id, ': ', addRelErr);
                                        } else {
                                            console.log('Successfully created ', addRelResults.length, ' relationships for: ', newDocument._id);
                                        }
                                    });
                                }

                                if (relationshipsIdsToDelete.length) {
                                    relationshipModel.remove({ _id: { $in: relationshipsIdsToDelete } }, (delRelErr, delRelResults) => {
                                        if (delRelErr) {
                                            console.log('Error while attemping to delete relationships for ', newDocument._id, ': ', delRelErr);
                                        } else {
                                            console.log('Successfully deleted ', delRelResults.length, ' relationships for: ', newDocument._id);
                                        }
                                    });
                                }
                            }
                        });
                    } else if (relatedIds && relatedIds.length === 0) {
                        relationshipModel.remove({ 'stix.source_ref': resultObj._id }, (delRelErr, delRelResults) => {
                            if (delRelErr) {
                                console.log('Error while attemping to delete relationships for ', newDocument._id, ': ', delRelErr);
                            } else {
                                console.log('Successfully deleted ', delRelResults.length, ' relationships for: ', newDocument._id);
                            }
                        });
                    }

                    if (existingAttachments) {
                        const attachmentIdsToDelete = existingAttachments
                            .map(eAtt => eAtt._id)
                            .filter(eId => !incomingAttachments || !incomingAttachments.map(iAtt => iAtt._id).includes(eId))
                            .map(eId => {
                                try {
                                    const idObj = new ObjectID(eId);
                                    return idObj;
                                } catch (_) {
                                    return null;
                                }
                            });
                        if (attachmentIdsToDelete.length) {
                            attachmentFilesModel.remove({ _id: { $in: attachmentIdsToDelete } }, (delRelErr, delRelResults) => {
                                if (delRelErr) {
                                    console.log('Error while attemping to delete attachment files for ', newDocument._id, ': ', delRelErr);
                                } else {
                                    console.log('Successfully deleted ', delRelResults.length, ' attachment files for: ', newDocument._id);
                                }
                            });
                            attachmentChunksModel.remove({ files_id: { $in: attachmentIdsToDelete } }, (delRelErr, delRelResults) => {
                                if (delRelErr) {
                                    console.log('Error while attemping to delete attachment chunks for ', newDocument._id, ': ', delRelErr);
                                } else {
                                    console.log('Successfully deleted ', delRelResults.length, ' attachment chunks for: ', newDocument._id);
                                }
                            });
                        }
                    }

                    const findOneAndUpdateQuery = this.applySecurityFilterWhenNeeded({ _id: id }, type, req.user, false);
                    // guard pass complete
                    model.findOneAndUpdate(findOneAndUpdateQuery, newDocument, { new: true }, (errUpdate, resultUpdate) => {
                        if (errUpdate) {
                            return res.status(500).json({
                                errors: [{
                                    status: 500, source: '', title: 'Error', code: '', detail: 'An unknown error has occurred.'
                                }]
                            });
                        }

                        if (resultUpdate) {
                            const resObj = resultUpdate.toObject();
                            const requestedUrl = apiRoot + req.originalUrl;
                            const convertedResult = jsonApiConverter.convertJsonToJsonApi(resObj.extendedProperties !== undefined ? { ...resObj.stix, ...resObj.extendedProperties } : resObj.stix, type, requestedUrl);
                            return res.status(200).json({ links: { self: requestedUrl, }, data: convertedResult });
                        }

                        return res.status(404).json({ message: `Unable to update the item.  No item found with id ${id}` });
                    });
                });
            } else {
                return res.status(400).json({
                    errors: [{
                        status: 400, source: '', title: 'Error', code: '', detail: 'malformed request'
                    }]
                });
            }
        };
    }

    deleteByIdCb(callback) {
        return (req, res) => {
            res.header('Content-Type', 'application/vnd.api+json');

            const id = req.swagger.params.id ? req.swagger.params.id.value : '';

            callback(req, res, id);
        };
    }

    deleteById() {
        const type = this.type;
        const model = this.model;
        const relationshipModel = modelFactory.getModel('relationship');

        return this.deleteByIdCb((req, res, id) => {
            const promises = [];
            // per mongo documentation
            // Mongoose queries are not promises. However, they do have a .then() function for yield and async/await.
            // If you need a fully- fledged promise, use the .exec() function.
            const query = this.applySecurityFilterWhenNeeded({ _id: id }, type, req.user, false);
            promises.push(model.remove(query).exec());
            promises.push(relationshipModel.remove({ $or: [{ 'stix.source_ref': id }, { 'stix.target_ref': id }] }).exec());
            Promise.all(promises).then(response => {
                if (response && response.length > 0 && response[0].result && response[0].result.n === 1) {
                    return res.status(200).json({ data: { type: 'Success', message: `Deleted id ${id}` } });
                }

                return res.status(404).json({ message: `Unable to delete the item.  No item found with id ${id}` });
            }).catch(err => { // eslint-disable-line no-unused-vars
                res.status(500).json({
                    errors: [{
                        status: 500, source: '', title: 'Error', code: '', detail: `An unknown error has occurred. [${err}]`
                    }]
                });
            });
        });
    }

    /**
     * @description apply filter for only give model types, user and node environment conditions
     * @see SecurityHelper#applySecurityFilter
     * @param {*} query
     * @param {*} type
     * @param {*} user
     */
    applySecurityFilterWhenNeeded(query, type, user, read = true) {
        if (!type || !query) {
            return query;
        }
        return SecurityHelper.applySecurityFilter(query, user, read);

        // const filterTypes = new Set(['x-unfetter-assessment', 'indicator', 'report']);
        // if (filterTypes.has(type)) {
        //     console.log(`applying filter on type ${type}`);
        //     return SecurityHelper.applySecurityFilter(query, user, read);
        // }
        // console.log(`skipping filter for type, ${type}`);
        // return query;
    }
};
