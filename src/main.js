import yargs from 'yargs'
import prompt from 'prompt'
import cliProgress from 'cli-progress'
import sqlite3 from 'sqlite3'
import AWS from 'aws-sdk'
import colors from 'colors'
import path from 'path'
import fs from 'fs'
import pThrottle from 'p-throttle'
import PQueue from 'p-queue'
import AgentKeepAlive from 'agentkeepalive'

const options = yargs
    .option('input', {describe: 'The mbtiles file', type: 'string', demandOption: true})
    .option('outputType', {describe: 'Where you want to store the tiles', type: 'string', default: 'S3', choices: ['S3', 'local']})
    .option('maxOperations', {describe: 'The maximum number of requests or files to write', type: 'integer', default: 2000})
    .option('inRoot', {describe: 'Should the tiles be put in the root of the location', type: 'boolean', default: false})
    .option('tileDir', {describe: 'A directory to place the tiles in within the output dir or bucket', type: 'string', default: 'tiles'})
    .option('minZoom', {describe: 'The minimum zoom level of tiles to transfer.', type: 'integer', default: 0})
    .option('maxZoom', {describe: 'The max zoom level of tiles to transfer, otherwise uses the max level available.', type: 'integer'})
    .option('fileExtension', {describe: 'Overrides the file extension contained in the metadata table.', type: 'string'})

    // AWS S3 related options
    .option('bucket', {describe: 'The name of the bucket', type: 'string'})
    .option('awsProfile', {describe: 'A named profile to use', type: 'string'})
    .option('acl', {describe: 'ACL of the uploaded file', type: 'string', default: 'public-read'})

    // Local storage options
    .option('localOutDir', {describe: 'A directory to place the files in locally', type: 'string'})
    .argv;


const defaultAgent = new AgentKeepAlive.HttpsAgent({
    keepAlive: true,
    maxSockets: 128,
    freeSocketTimeout: 60000
});

const cliBar = new cliProgress.SingleBar({
    format: `Uploading  ${colors.cyan('[{bar}]')} {percentage}% | Duration: {duration_formatted}`,
}, cliProgress.Presets.legecy)


function getOutputFilename (row) {
    // Flip Y coordinate because MBTiles files are TMS.
    // tip from https://github.com/mapbox/node-mbtiles/blob/master/lib/mbtiles.js#L158-L159
    const y = (1 << row.zoom_level) - 1 - row.tile_row;
    return `${options.basePath}${row.zoom_level}/${row.tile_column}/${y}.${options.fileExtension}`
}

async function adoptProfile () {
    const getMfa = (serial, cb) => {
        prompt.message = ''
        const schema2 = {
            properties: {
                MFA: {
                    description: colors.white('Enter the AWS MFA'),
                    type: 'string',
                    required: true,
                    hidden: true
                }
            }
        }
        prompt.start()
        prompt.get(schema2, (err, r) => {
            if (err) errorEncounted(err)
            cb(null, r.MFA);
        });
    };

    const creds = new AWS.SharedIniFileCredentials({
        profile: options.awsProfile,
        tokenCodeFn: getMfa
    });
    await creds.getPromise()

    AWS.config.credentials = creds //eslint-disable-line
    const sts = new AWS.STS()
    return new Promise((resolve) => {
        sts.assumeRole({
            RoleSessionName: 'tile-upload',
            RoleArn: creds.roleArn
        }, function (err, data) {
            if (err) errorEncounted(err)
            resolve({
                accessKeyId: data.Credentials.AccessKeyId,
                secretAccessKey: data.Credentials.SecretAccessKey,
                sessionToken: data.Credentials.SessionToken,
            })
        });
    })
}

let totalTileCount = 0
let processed = 0

function tileAdded () {
    processed++
}

let s3 = null
let contentType = null
let contentEncoding = null

const putInBucket = pThrottle(row => new Promise((resolve) => {
    const tileOptions = {
        ACL: options.acl,
        Body: row.tile_data,
        Bucket: options.bucket,
        Key: getOutputFilename(row),
        ContentType: contentType,
        ContentEncoding: contentEncoding
    }

    s3.putObject(tileOptions, function(err) {
        if (err) errorEncounted(err)
        tileAdded()
        resolve()
    })
}), options.maxOperations, 1000)

const storeLocally = pThrottle(row => new Promise((resolve) => {
    const outName = `${path.join(options.localOutDir, getOutputFilename(row))}`
    if (!fs.existsSync(outName)) fs.mkdirSync(path.dirname(outName), {recursive: true})
    fs.writeFile(outName, row.tile_data, function(err) {
        if (err) errorEncounted(err)
        tileAdded()
        resolve()
    })
}), options.maxOperations, 1000)

const queue = new PQueue({concurrency: options.maxOperations});

function result (err, row) {
    if (err) errorEncounted(err);
    if (options.outputType === 'S3') queue.add(() => putInBucket(row))
    if (options.outputType === 'local') queue.add(() => storeLocally(row))
}

function processMetadata (rows) {
    rows.forEach(function (r) {
        if (r.name === 'minzoom') {
            options.minZoom = options.minZoom ? options.minZoom : r.value
        }
        if (r.name === 'maxzoom') {
            options.maxZoom = options.maxZoom ? options.maxZoom : r.value
        }
        if (r.name === 'format') {
            let ext = null
            if (r.value === 'image/png') {
                contentType = r.value
                ext = '.png'
            } else if (r.value === 'image/jpeg') {
                contentType = r.value
                ext = '.jpg'
            } else if (r.value === 'pbf') {
                contentType = 'application/x-protobuf'
                ext = '.pbf'
                contentEncoding = 'gzip'
            }
            options.fileExtension = options.fileExtension ? options.fileExtension : ext
        }
    })
}

let chunk = 0
async function onChunkCompletion () {
    chunk++
    await queue.onIdle();
    cliBar.update((processed / totalTileCount) * 100);
    if (processed < totalTileCount) {
        processChunk()
    } else if (processed === totalTileCount) {
        completed()
    } else if (processed < totalTileCount) {
        errorEncounted('This shouldnt happen')
    }
}

let db = null
function processChunk () {
    db.each(`SELECT * FROM tiles WHERE zoom_level BETWEEN ${options.minZoom} AND ${options.maxZoom} LIMIT ${options.maxOperations} OFFSET ${(chunk * options.maxOperations)}`, [], result, onChunkCompletion)
}

async function processMbTiles () {
    db = new sqlite3.Database(`${options.input}`, sqlite3.OPEN_READONLY, async function (err) { // eslint-disable-line
        if (err) errorEncounted(err)
        this.all('SELECT * FROM metadata', [],  (err, rows) => {
            if (err) errorEncounted(err)
            processMetadata(rows)
            this.all(`SELECT COUNT(*) FROM tiles WHERE zoom_level BETWEEN ${options.minZoom} AND ${options.maxZoom}`, [], (err, rows) => {
                if (err) errorEncounted(err)
                totalTileCount = rows[0]['COUNT(*)']
                cliBar.start(100, 0);
                processChunk()
            })
        })
    })
}

prompt.message = ''
const schema = {
    properties: {
        agree: {
            description: colors.cyan('Files already exist in that location, are you sure you want to continue? t/rue or f/alse'),
            type: 'boolean',
            message: 'Must respond true/t or false/f',
            required: true
        }
    }
}

export async function cli () {
    // remove a traiing slash from the tileDir
    options.tileDir = options.tileDir.replace(/\/$/, '')
    options.basePath = options.inRoot ? '' : `${options.tileDir}/`

    if (options.outputType === 'S3') {
        if (options.bucket === undefined) errorEncounted('For outputType=S3 you must specify the bucket option')
        const awsOptions = {
            httpOptions: {
                timeout: 2000,
                agent: defaultAgent
            }
        }
        if (process.env.AWS_S3_ENDPOINT) {
            awsOptions.endpoint = new AWS.Endpoint(process.env.AWS_S3_ENDPOINT)
        }
        if (options.awsProfile) {
            const profile = await adoptProfile()
            Object.assign(awsOptions, profile);
        }
        s3 = new AWS.S3(awsOptions)
        const basePath = {
            Bucket: options.bucket,
            Prefix: options.basePath,
            MaxKeys: 1
        }

        // // Check if there are already any files in that dir
        s3.listObjects(basePath, function (err, data) {
            if (err) errorEncounted(err)
            if (data.Contents.length > 0) {
                prompt.start()
                prompt.get(schema, (err, result) => {
                    if (err) errorEncounted(err)
                    if (result.agree) processMbTiles()
                });
            } else {
                processMbTiles()
            }
        })
    } else if (options.outputType === 'local') {
        if (options.localOutDir === undefined) errorEncounted('For outputType=local you must specify the localOutDir option.')
        const dest = path.join(options.localOutDir, options.basePath)
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest)
            processMbTiles()
        } else {
            prompt.start()
            prompt.get(schema, (err, result) => {
                if (err) errorEncounted(err)
                if (result.agree) processMbTiles()
            });
        }
    }
}

function errorEncounted (err) {
    console.log(`
❌ Sorry but we couldn't complete the operation - check the error message below.

${err}
`)
    process.exit(0)
}

function completed () {
    cliBar.stop();
    const out = options.outputType === 'local' ? path.join(options.localOutDir, options.basePath) : `AWS S3 ${options.bucket}/${options.basePath}`
    console.log(`
🎉 All tiles written to ${out}
    `)
}

