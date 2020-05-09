Take tiles from an mbtiles file locally (eg vector tiles) and extracts them to ZXY structure in an S3 bucket or locally. Also works for mbtiles files containing raster tiles.

````
npm install -g mbtiles-extractor

mbtiles-extractor --input=some.mbtiles --bucket=myTiles --maxZoom=10

Uploading [========================================] 100% | ETA: 0s | Duration: 11s

🎉  All tiles written to AWS S3 myTiles/tiles/

// or using locally

mbtiles-extractor --input=some.mbtiles --outputType=local --localOutDir=Data --tileDir=mytiles

🎉 All tiles written to /Data/mytiles

````

### Features
- Supports vector and raster tiles
- Throws a prompt if you're about to override existing content in a bucket or local directory
- Uses concurrent PUT requests to AWS S3 and file writes locally

### Options
`--input` **Required** The filepath of an mbtiles file. Eg `--input=some.mbtiles`

`--outputType=S3` Where you want to store the tiles, either `S3` or `local`. Defaults to S3.

`--inRoot=false` If you want to place the tiles in the root of the output location (using no `tileDir`)

`--tileDir=tiles` A directory to place the tiles in within the output dir or bucket. Quite handy using with S3.

`--minZoom=0` The minimum zoom level of tiles to transfer. Eg if `minZoom=3` then levels 1 & 2 will not be transfered

`--maxZoom` The maximum zoom level of tiles to transfer. Eg if `maxZoom=4` then levels 5 and above won't be transfered. If not specified this is calculated from the mbtiles file.

`--fileExtension` Overrides the file extension contained in the `metadata` table.

`--maxOperations` The maximum number of requests or files to write, defaults to 1000. [AWS advises](https://aws.amazon.com/about-aws/whats-new/2018/07/amazon-s3-announces-increased-request-rate-performance/) it's possible to send as many as 3500 per second.

#### AWS S3 Related Options

`--bucket` The name of a pre-existing bucket to put the tiles in.

`--awsProfile` The name of an AWS profile to use.

`--acl=public-read` The access control level of the tile.

#### Local storage options

`--localOutDir` **Required** The name of a folder to place the tiles in.


### Handling AWS roles & profiles
If you need to use a named profile pass in the `awsProfile` option.

For example
````
export AWS_SDK_LOAD_CONFIG=1
export AWS_SHARED_CREDENTIALS_FILE=$HOME/.aws/credentials
export AWS_CONFIG_FILE=$HOME/.aws/config
// Followed by

mbtiles-extractor --input=EEZ.mbtiles --bucket=someBucket --tileDir=EEZ --maxZoom=10 --awsProfile=myNamedProfile

````

### Motivation
I ran into lots of grief with `mapbox-tile-copy` across various node versions. It has a huge nesting of dependencies which seemed to get confused around various binding versions for sqllite3 and mapnik etc. This library is fair bit simpler in it's dependencies. 

This cli is also a bit faster 
- node-mbtiles [as described here](https://github.com/mapbox/node-mbtiles#hook-up-to-tilelive)
148 seconds
- mbtiles-extractor 117 seconds

### To Do
- Investigate storing in Azure or Google Cloud
