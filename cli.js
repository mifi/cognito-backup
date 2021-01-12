#!/usr/bin/env node

'use strict';

const meow = require('meow');
const AWS = require('aws-sdk');
const bluebird = require('bluebird');
const fs = require('fs');
const path = require('path');
const sanitizeFilename = require('sanitize-filename');
const JSONStream = require('JSONStream');
const streamToPromise = require('stream-to-promise');
const debug = require('debug')('cognito-backup');
const mkdirp = bluebird.promisify(require('mkdirp'));
const assert = require('assert');
const Bottleneck = require('bottleneck');

const readFile = bluebird.promisify(fs.readFile);


function getFilename(userPoolId) {
  return `${userPoolId}.json`;
}

function listUserPools(region) {
  const cognitoIsp = new AWS.CognitoIdentityServiceProvider({ region });

  return cognitoIsp.listUserPools({ MaxResults: 60 }).promise()
    .then((data) => {
      assert(!data.NextToken, 'More than 60 user pools is not yet supported');
      const userPools = data.UserPools;
      debug({ userPools });
      return userPools.map(p => p.Id);
    });
}

function backupUsers(cognitoIsp, userPoolId, file) {
  const writeStream = fs.createWriteStream(file);
  const stringify = JSONStream.stringify();

  stringify.pipe(writeStream);

  const params = { UserPoolId: userPoolId };
  const page = () => {
    debug(`Fetching users - page: ${params.PaginationToken || 'first'}`);
    return bluebird.resolve(cognitoIsp.listUsers(params).promise())
      .then((data) => {
        const promises = data.Users.map((item) => {
          const itemCopy = item;
          return cognitoIsp.adminListGroupsForUser({
            UserPoolId: userPoolId, Username: item.Username,
          }).promise().then((gdata) => {
            itemCopy.Groups = gdata.Groups.map(group => group.GroupName);
            stringify.write(itemCopy);
          });
        });

        if (data.PaginationToken !== undefined) {
          params.PaginationToken = data.PaginationToken;
          promises.push(page());
        }

        return bluebird.all(promises);
      });
  };

  return page()
    .finally(() => {
      stringify.end();
      return streamToPromise(stringify);
    })
    .finally(() => writeStream.end());
}


function backupUsersCli(cli) {
  const userPoolId = cli.input[1];
  const { region, file } = cli.flags;
  const file2 = file || sanitizeFilename(getFilename(userPoolId));

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

  const cognitoIsp = new AWS.CognitoIdentityServiceProvider({ region });

  return backupUsers(cognitoIsp, userPoolId, file2);
}

function backupAllUsersCli(cli) {
  const { region } = cli.flags;
  const dir = cli.flags.dir || '.';

  const cognitoIsp = new AWS.CognitoIdentityServiceProvider({ region });

  return mkdirp(dir)
    .then(() => bluebird.mapSeries(listUserPools(region), (userPoolId) => {
      const file = path.join(dir, getFilename(userPoolId));
      console.error(`Exporting ${userPoolId} to ${file}`);
      return backupUsers(cognitoIsp, userPoolId, file);
    }));
}

function restore(cli) {
  const { region, file } = cli.flags;
  const userPoolId = cli.input[1];
  const tempPassword = cli.input[2];
  const file2 = file || sanitizeFilename(getFilename(userPoolId));

  const cognitoIsp = new AWS.CognitoIdentityServiceProvider({ region });

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

  if (!tempPassword) {
    console.error('temp-password is required');
    cli.showHelp();
  }

  // AWS limits to 10 per second, so be safe and do 4 per second
  // https://docs.aws.amazon.com/cognito/latest/developerguide/limits.html
  const limiter = new Bottleneck({ minTime: 250 });


  // TODO make streamable
  readFile(file2, 'utf8')
    .then((data) => {
      const users = JSON.parse(data);

      return bluebird.mapSeries(users, async (user) => {
        // sub is non-writable attribute
        const attributes = user.Attributes.filter(a => a.Name !== 'sub');

        const params = {
          UserPoolId: userPoolId,
          Username: user.Username,
          DesiredDeliveryMediums: [],
          MessageAction: 'SUPPRESS',
          ForceAliasCreation: false,
          TemporaryPassword: tempPassword.toString(),
          UserAttributes: attributes,
        };

        const wrapped = limiter.wrap(async () => cognitoIsp.adminCreateUser(params).promise());
        const response = await wrapped();
        console.log(response);

        if (user.Groups) {
          user.Groups.forEach(async (group) => {
            const iparams = {
              UserPoolId: userPoolId,
              Username: user.Username,
              GroupName: group,
            };
            const iwrapped = limiter.wrap(async () => cognitoIsp.adminAddUserToGroup(iparams).promise());
            const iresponse = await iwrapped();
            console.log(iresponse);
          });
        }
      });
    });
}


const cli = meow(`
    Usage
      $ cognito-backup backup-users <user-pool-id> <options>  Backup/export all users in a single user pool
      $ cognito-backup backup-all-users <options>  Backup all users in all user pools for this account
      $ cognito-backup restore-users <user-pool-id> <temp-password>  Restore/import users to a single user pool

      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION
      can be specified in env variables or ~/.aws/credentials

    Options
      --region AWS region
      --file File name to export/import single pool users to (defaults to user-pool-id.json)
      --dir Path to export all pools, all users to (defaults to current dir)
      --profile utilize named profile from .aws/credentials file
`);

const methods = {
  'backup-users': backupUsersCli,
  'backup-all-users': backupAllUsersCli,
  'restore-users': restore,
};

const method = methods[cli.input[0]] || cli.showHelp();

if (cli.flags.profile) {
  AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile: cli.flags.profile });
}

bluebird.resolve(method.call(undefined, cli))
  .catch((err) => {
    console.error(err.stack);
    process.exit(1);
  });
