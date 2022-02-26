#!/usr/bin/env node

import { promisify } from 'util';
import meow from 'meow';
import AWS from 'aws-sdk';
import fs from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import sanitizeFilename from 'sanitize-filename';
import JSONStream from 'JSONStream';
import Debug from 'debug';
import mkdirp from 'mkdirp';
import assert from 'assert';
import Bottleneck from 'bottleneck';
import { pipeline as pipelineCb } from 'stream';
import pMap from 'p-map';

const debug = Debug('cognito-backup');

const pipeline = promisify(pipelineCb);


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
    --stack-trace Log stack trace upon error`,
  {
    importMeta: import.meta,
    flags: {
      stackTrace: {
        type: 'boolean',
      },
    }
  });

const { region } = cli.flags;


function getFilename(userPoolId) {
  return `${userPoolId}.json`;
}

function getCognitoISP() {
  return new AWS.CognitoIdentityServiceProvider({ region });
}

async function listUserPools() {
  const cognitoIsp = getCognitoISP();

  const data = await cognitoIsp.listUserPools({ MaxResults: 60 }).promise()
  assert(!data.NextToken, 'More than 60 user pools is not yet supported');
  const userPools = data.UserPools;
  debug({ userPools });
  return userPools.map(p => p.Id);
}

async function backupUsers(cognitoIsp, userPoolId, file) {
  const writeStream = fs.createWriteStream(file);
  const stringify = JSONStream.stringify();

  const params = { UserPoolId: userPoolId };

  async function page() {
    debug(`Fetching users - page: ${params.PaginationToken || 'first'}`);
    const data = await cognitoIsp.listUsers(params).promise();
    data.Users.forEach(item => stringify.write(item));

    if (data.PaginationToken !== undefined) {
      params.PaginationToken = data.PaginationToken;
      await page();
    }

    stringify.end();
  }

  page();
  await pipeline(stringify, writeStream);
}

async function backupUsersCli() {
  const userPoolId = cli.input[1];
  const { file } = cli.flags;
  const file2 = file || sanitizeFilename(getFilename(userPoolId));

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

  const cognitoIsp = getCognitoISP();

  return backupUsers(cognitoIsp, userPoolId, file2);
}

async function backupAllUsersCli() {
  const dir = cli.flags.dir || '.';

  const cognitoIsp = getCognitoISP();

  await mkdirp(dir);
  await pMap(await listUserPools(), (userPoolId) => {
    const file = path.join(dir, getFilename(userPoolId));
    console.error(`Exporting ${userPoolId} to ${file}`);
    return backupUsers(cognitoIsp, userPoolId, file);
  }, { concurrency: 1 });
}

async function restore() {
  const { file } = cli.flags;
  const userPoolId = cli.input[1];
  const tempPassword = cli.input[2];
  const file2 = file || sanitizeFilename(getFilename(userPoolId));

  const cognitoIsp = getCognitoISP();

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
  const data = await readFile(file2, 'utf8')
  const users = JSON.parse(data);

  return pMap(users, async (user) => {
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
  }, { concurrency: 1 });
}

const methods = {
  'backup-users': backupUsersCli,
  'backup-all-users': backupAllUsersCli,
  'restore-users': restore,
};

const method = methods[cli.input[0]] || cli.showHelp();

if (cli.flags.profile) {
  AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile: cli.flags.profile });
}

try {
  await method()
} catch (err) {
  if (cli.flags.stackTrace) {
    console.error('Error:', err);
  } else {
    console.error('Error:', err.message);
  }
  process.exitCode = 1;
}
