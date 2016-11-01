#!/usr/bin/env node
'use strict';

const meow = require('meow');
const AWS = require('aws-sdk');
const bluebird = require('bluebird');
const fs = require('fs');
const sanitizeFilename = require('sanitize-filename');
const JSONStream = require('JSONStream');
const streamToPromise = require('stream-to-promise');
const debug = require('debug')('cognito-backup');

const cli = meow(`
    Usage
      $ cognito-backup backup-users <user-pool-id> <options>  Backup all users

      AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
      is specified in env variables or ~/.aws/credentials

    Options
      --region AWS region
      --file File name to export to (defaults to user-pool-id.json)
`);

const methods = {
  'backup-users': backupUsers,
};

const method = methods[cli.input[0]] || cli.showHelp();

bluebird.resolve(method.call(undefined, cli))
  .catch(err => {
    console.error(err.stack);
    process.exit(1);
  });


function backupUsers(cli) {
  const userPoolId = cli.input[1];
  const region = cli.flags.region;
  const file = cli.flags.file;
  const file2 = file || sanitizeFilename(userPoolId + '.json');

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

  const cognitoIsp = new AWS.CognitoIdentityServiceProvider({ region });
  const writeStream = fs.createWriteStream(file2);
  const stringify = JSONStream.stringify();

  stringify.pipe(writeStream);

  const params = { UserPoolId: userPoolId };
  const page = () => {
    debug(`Fetching users - page: ${params.PaginationToken || 'first'}`);
    return bluebird.resolve(cognitoIsp.listUsers(params).promise())
      .then(data => {
        data.Users.forEach(item => stringify.write(item));

        if (data.PaginationToken !== undefined) {
          params.PaginationToken = data.PaginationToken;
          return page();
        }
      });
  }

  return page()
    .finally(() => {
      stringify.end();
      return streamToPromise(stringify);
    })
    .finally(() => writeStream.end());
}
