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


const cli = meow(
  `
  Usage
    $ cognito-backup backup-users <user-pool-id> <options>  Backup/export all users in a single user pool
    $ cognito-backup backup-groups <user-pool-id> <options>  Backup/export all groups in a single user pool
    $ cognito-backup backup-all-users <options>  Backup all users in all user pools for this account
    $ cognito-backup restore-users <user-pool-id> <temp-password>  Restore/import users to a single user pool
    $ cognito-backup restore-groups <user-pool-id> Restore/import groups to a single user pool

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
    },
  },
);

const { region } = cli.flags;


function getFilename(userPoolId) {
  return `${userPoolId}.json`;
}

function getCognitoISP() {
  return new AWS.CognitoIdentityServiceProvider({ region });
}

async function listUserPools() {
  const cognitoIsp = getCognitoISP();

  const data = await cognitoIsp.listUserPools({ MaxResults: 60 }).promise();
  assert(!data.NextToken, 'More than 60 user pools is not yet supported');
  const userPools = data.UserPools;
  debug({ userPools });
  return userPools.map((p) => p.Id);
}

async function backupUsers(cognitoIsp, userPoolId, file) {
  const writeStream = fs.createWriteStream(file);
  const stringify = JSONStream.stringify();

  const params = { UserPoolId: userPoolId };

  const limiter = new Bottleneck({ minTime: 25 });

  // AWS limits to 50 API calls for AdminListGroupsForUser per second, so be safe and do 40 per second
  // https://docs.aws.amazon.com/cognito/latest/developerguide/limits.html#category_operations
  const getUserGroupNames = limiter.wrap(async (user) => {
    const data = await cognitoIsp.adminListGroupsForUser({
      UserPoolId: userPoolId,
      Username: user.Username,
    }).promise();

    return data.Groups.map((group) => group.GroupName);
  });

  async function page() {
    debug(`Fetching users - page: ${params.PaginationToken || 'first'}`);
    const data = await cognitoIsp.listUsers(params).promise();

    const users = await Promise.all(data.Users.map(async (user) => {
      const groupNames = await getUserGroupNames(user);
      return { ...user, Groups: groupNames };
    }));

    users.forEach((item) => stringify.write(item));

    if (data.PaginationToken !== undefined) {
      params.PaginationToken = data.PaginationToken;
      await page();
      return;
    }

    stringify.end();
  }

  page();
  await pipeline(stringify, writeStream);
}

async function backupGroups(cognitoIsp, userPoolId, file) {
  const writeStream = fs.createWriteStream(file);
  const stringify = JSONStream.stringify();

  const params = { UserPoolId: userPoolId, Limit: 1 };

  async function page() {
    debug(`Fetching groups - page: ${params.PaginationToken || 'first'}`);
    const data = await cognitoIsp.listGroups(params).promise();
    data.Groups.forEach((item) => stringify.write(item));

    if (data.NextToken !== undefined) {
      params.NextToken = data.NextToken;
      await page();
      return;
    }

    stringify.end();
  }

  page();
  await pipeline(stringify, writeStream);
}

const getUserPoolFileName = (userPoolId) => cli.flags.file || sanitizeFilename(getFilename(userPoolId));
const getUserPoolGroupFileName = (userPoolId) => cli.flags.file || sanitizeFilename(getFilename(`${userPoolId}_groups`));

async function backupUsersCli() {
  const userPoolId = cli.input[1];
  const file = getUserPoolFileName(userPoolId);

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

  return backupUsers(getCognitoISP(), userPoolId, file);
}

function backupGroupsCli() {
  const userPoolId = cli.input[1];
  const file = getUserPoolGroupFileName(userPoolId);

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

  return backupGroups(getCognitoISP(), userPoolId, file);
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

async function restoreUsers() {
  const userPoolId = cli.input[1];
  const tempPassword = cli.input[2];
  const file = getUserPoolFileName(userPoolId);

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
  const data = await readFile(file, 'utf8');
  const users = JSON.parse(data);

  return pMap(users, async (user) => {
    // sub is non-writable attribute
    const attributes = user.Attributes.filter((attribute) => attribute.Name !== 'sub');

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
      await Promise.all(user.Groups.map(async (group) => {
        const groupParams = {
          UserPoolId: userPoolId,
          Username: user.Username,
          GroupName: group,
        };
        const addUserToGroup = limiter.wrap(async () => cognitoIsp.adminAddUserToGroup(groupParams).promise());
        const groupResponse = await addUserToGroup();
        console.log(groupResponse);
      }));
    }
  }, { concurrency: 1 });
}

async function restoreGroups() {
  const userPoolId = cli.input[1];
  const file = getUserPoolGroupFileName(userPoolId);

  const cognitoIsp = getCognitoISP();

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

  // AWS limits to 10 per second, so be safe and do 4 per second
  // https://docs.aws.amazon.com/cognito/latest/developerguide/limits.html
  const limiter = new Bottleneck({ minTime: 250 });

  // TODO make streamable
  const data = await readFile(file, 'utf8');
  const groups = JSON.parse(data);

  return pMap(groups, async (group) => {
    const params = {
      UserPoolId: userPoolId,
      GroupName: group.GroupName,
      Description: group.Description,
      Precedence: group.Precedence,
      RoleArn: group.RoleArn,
    };

    const wrapped = limiter.wrap(async () => cognitoIsp.createGroup(params).promise());
    const response = await wrapped();
    console.log(response);
  }, { concurrency: 1 });
}

const methods = {
  'backup-users': backupUsersCli,
  'backup-groups': backupGroupsCli,
  'backup-all-users': backupAllUsersCli,
  'restore-users': restoreUsers,
  'restore-groups': restoreGroups,
};

const method = methods[cli.input[0]] || cli.showHelp();

if (cli.flags.profile) {
  AWS.config.credentials = new AWS.SharedIniFileCredentials({ profile: cli.flags.profile });
}

try {
  await method();
} catch (err) {
  if (cli.flags.stackTrace) {
    console.error('Error:', err);
  } else {
    console.error('Error:', err.message);
  }
  process.exitCode = 1;
}
