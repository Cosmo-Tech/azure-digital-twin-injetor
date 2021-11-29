/**
 * copyright (c) cosmo tech corporation.
 * licensed under the mit license.
 *
 * This module exports 2 functions:
 * csv2json: that reads CSV data line by line and convert it to json
 * send2queue: that store inoformation in an Azure Storage Queue
 *
 * Inserting to the queue is batched and timedout in order to respect
 * Azure Function limits on max outbound connections.
 * https://docs.microsoft.com/en-us/azure/azure-functions/functions-scale#service-limits
 * You can define an env var LOG_DETAILS in order to get details of parsing.
 * Throws exception if there are parsing errors or issues sending to queue.
 */

const {DigitalTwinsClient} = require('@azure/digital-twins-core');
const {DefaultAzureCredential} = require('@azure/identity');
const {QueueClient} = require('@azure/storage-queue');
const Papa = require('papaparse');
const https = require('https');


/* Limit the number of outbound connections to 200
 *   (higher value of 500 does not work).
 * Works with option to disable keep alive on client further.
 * https://github.com/Azure/azure-functions-host/wiki/Host-Health-Monitor
 */
https.globalAgent.maxSockets = 200;


/**
 * Queue configuration from env variables
 * See under Settings / Configuration
 */
const queueClient = new QueueClient(
    process.env.JSON_STORAGE_CONNECTION,
    process.env.JSON_STORAGE_QUEUE,
    {
        keepAliveOptions: {enable: false},
    },
);


/**
 * Retreive model schema from ADT
 * @param {String} Model id at DTDL format
 * @return {Object} Map of all property as keys and expected type as values
 */
function extractSchemaDataType(context, modelId) {
    context.log('reading DTDL schema for type detection')
    let modelId = `dtmi:${context.bindingData.filename};1`
    context.log.verbose('creating ADT client');
    const digitalTwin = new DigitalTwinsClient(
        process.env.DIGITAL_TWINS_URL,
        new DefaultAzureCredential());
    modelSchema = await digitalTwin.getModel(modelId, true)
        .catch((e) => {
            context.log.error(`Error occured while retreving model of ${modelId}\n${e.message}`);
            throw e;
        });
    console.log(modelSchema)
    propertiesDataType = {}
    for (const c in modelSchema.contents) {
        if (c['@type'] == 'Property') {
            // TODO extract expected type from model and match to json type
            // return map <name,type>
        }
    }
}


/**
 * Transform a relationship object with keys matching expected DTDL data format
 * @param {object} relationship csv object
 * @return {object} relation csv object at DTDL data format
 */
function relationshipDirectTransform(context, relationshipObject) {
    if (!('$relationshipId' in results.meta.fields)) {
        m = 'Missing $relationshipId';
        context.log.error(m);
        throw m;
    } else if (!('$target' in results.meta.fields)) {
        m = 'Missing $target';
        context.log.error(m);
        throw m;
    } else if (!('$relationshipName' in results.meta.fields)) {
        m = 'Missing $relationshipName';
        context.log.error(m);
        throw m;
    }

    context.log('Direct Transforming relationship file...')
    newRelationshipObject = {};
    newRelationshipObject['$sourceId'] = relationshipObject['$sourceId'];
    newRelationshipObject['$targetId'] = relationshipObject['$targetId'];
    
    delete relationshipObject['$sourceId'];
    delete relationshipObject['$targetId'];

    newRelationshipObject['relationship'] = relationshipObject;

    return newRelationshipObject;
}


/**
 * Transform a relationship object (just parsed from csv) to match expected DTDL data format
 * @param {Object} relationship csv object
 * @return {Object} relationship csv object at DTDL data format
 */
function relationshipCsvObject2DTDL(context, relationshipObject) {
    if (!('source' in relationshipObject) || relationshipObject['source'] === null)
        throw `relationship object from ${context.bindingData.filename} doesn't contains source`;
    if (!('target' in relationshipObject) || relationshipObject['target'] === null)
        throw `relationship object from ${context.bindingData.filename} doesn't contains target`;

    context.log('Transforming relationship file...')
    newRelationshipObject = {}
    // Create relationshipID
    newRelationshipObject['$relationshipId'] = relationshipObject['source'].concat('-', relationshipObject['target'])

    // Mod source to $sourceId
    newRelationshipObject['$sourceId'] = relationshipObject['source']
    delete relationshipObject['source']

    // Create relationship 
    newRelationshipObject['relationship'] = {}
    // Mod target to $targetId
    newRelationshipObject['relationship']['$targetId'] = relationshipObject['target']
    delete relationshipObject['target']

    // Add $relationshipName
    newRelationshipObject['relationship']['$relationshipName'] = context.bindingData.filename

    // Add the rest of relationship json to relationship attributes
    for (const k in relationshipObject) {
        newRelationshipObject['relationship'][k] = relationshipObject[k];
    }
    return newRelationshipObject;
}


/**
 * Transform a twin object with keys matching expected DTDL data format
 * @param {object} twin csv object
 * @return {object} twin csv object at DTDL data format
 */
function twinDirectTranform(context, twinObject) {
    if (!('$metadata.$model' in results.meta.fields)) {
        context.log.error('Missing $metadata.$model; For twinDirectTransform $id et $metadata.$model are mandatory');
        throw 'Missing $metadata.$model';
    }

    context.log('Direct transforming twin file...');
    twinObject["$metadata"] = {"$model": twinObject['$metadata.$model']};  
    delete twinObject['$metadata.$model'] ;

    return twinObject;
}


/**
 * Transform a twin object (just parsed from csv) to match expected DTDL data format
 * @param {Object} twin csv object
 * @return {Object} twin csv object to DTDL data format
 */
async function twinCsvObject2DTDL(context, twinObject) {
    if (!('id' in twinObject) || twinObject['id'] === null)
        throw `Twin object from ${context.bindingData.filename} doesn't contains id`;

    context.log('Transforming twin file...')
    for (const k in twinObject) {
        v = twinObject[k];
        if (typeof(v) == 'string') {
            // Specific condition for technical policy attributes CriteriaFormula
            // Avoid truning stringed json back to json
            // TODO: Check expected type from dtdl before
            if (k != 'CriteriaFormula' && v.includes('{')) {
                // Mod stringed map/object back to origin form
                twinObject[k] = JSON.parse(v);
            } else if (/[+-]?\d(\.\d+)?[Ee][+-]?\d+/.test(v)) {
                // Mod stringed scientific notation float back to float.
                twinObject[k] = Number(v);
            }
        } else if(v === null) {
            delete twinObject[k];
        }
    }
    // Add ADT model ref
    twinObject["$metadata"] = {"$model": modelId};  
    // Mod id to be DTDL ref $id
    twinObject["$id"] = twinObject["id"]
    delete twinObject["id"]
    return twinObject;
}


/**
 * Send a message to the Azure Storage Queue
 * @param {Object} content the object to send
 */
function send2queue(context, content) {
    context.log.verbose(`Queue client: ${process.env.JSON_STORAGE_QUEUE}`);
    context.log.verbose('Queue: create if not exist');
    queueClient.createIfNotExists();
    context.log('Sending message to queue');
    context.log.verbose(content)
    queueClient.sendMessage(
        Buffer.from(JSON.stringify(content)).toString('base64'))
        .catch((e) => {
            const err = `error sending message: ${e}`;
            throw err;
        });
}


async function csv2json(context, csvData) {
    filename = context.bindingData.filename;
    context.log(`Running csv2json on ${filename}...`);
    context.log('Parsing CSV data...');
    let count = 0;
    let cumulatedIds = '';
    Papa.parse(csvData.toString('utf8'), {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: 'greedy',
        step: function(results, parser) {
            context.log('Parser step');
            context.log.verbose('Iterating results data');
            context.log.verbose(`Results data: ${JSON.stringify(results.data)}`);
            cumulatedIds = `${cumulatedIds},${results.data.$id}`;
            ++count;
            // Discriminate twins from relations
            // TODO: Find an other way to discriminate
            if ('$id' in results.meta.fields) {
                results.data = twinDirectTransform(context, results.data)
            } else if ('$source' in results.meta.fiels) {
                results.data = relationshipDirectTranform(context, results.data);
            } else if (JSON.stringify(results.meta.fields) === JSON.stringify(['source', 'target'])) {
                results.data = relationshipCsvObject2DTDL(context, results.data);
            } else {
                results.data = twinCsvObject2DTDL(context, results.data);
            }
            send2queue(context, results.data);
        },
        error: function(err, file, inputElem, reason) {
            context.log.error(`Papaparse error: ${err}, file: ${file},
                inputElem: ${inputElem}, reason: ${reason}`);
            context.log.verbose(`Cumulated ids: ${cumulatedIds}`);
            throw err;
        },
        complete: function() {
            context.log(`Total sent messages: ${count.toString()}`);
            context.log.verbose(`Cumulated ids: ${cumulatedIds}`);
        },
    });
};


module.exports = {
    csv2json: csv2json, 
    send2queue: send2queue, 
    twinCsvObject2DTDL: twinCsvObject2DTDL,
    relationshipCsvObject2DTDL: relationshipCsvObject2DTDL,
    queueClient: queueClient
}
