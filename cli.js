#!/usr/bin/env node

import { promisify } from 'util';
import meow from 'meow';
import fs from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import sanitizeFilename from 'sanitize-filename';
import JSONStream from 'JSONStream';
import Debug from 'debug';
import mkdirp from 'mkdirp';
import assert from 'assert';
import { pipeline as pipelineCb } from 'stream';
import pMap from 'p-map';
import {
  CognitoIdentityProviderClient, ListUserPoolsCommand, AdminListGroupsForUserCommand, ListUsersCommand, ListGroupsCommand, AdminCreateUserCommand, CreateGroupCommand, AdminAddUserToGroupCommand, GroupExistsException, UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { fromIni } from '@aws-sdk/credential-providers';

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
    --stack-trace Log stack trace upon error
    --max-attempts The maximum number of times requests that encounter retryable failures should be attempted
    --include-groups Toggles backing up user group memberships to save on API calls where not required
    --concurrency More will be faster, too many may cause throttling error`,
  {
    importMeta: import.meta,
    flags: {
      stackTrace: {
        type: 'boolean',
      },
      maxAttempts: {
        type: 'number',
      },
      includeGroups: {
        type: 'boolean',
      },
      concurrency: {
        type: 'number',
      },
      verbose: {
        type: 'boolean',
      },
    },
  },
);

const {
  region,
  concurrency = 1,
  verbose = false,
  maxAttempts = 5,
  includeGroups = true,
} = cli.flags;

const config = {
  region,
  retryMode: 'standard',
  maxAttempts,
};

if (cli.flags.profile) {
  config.credentials = fromIni({
    profile: cli.flags.profile,
  });
}

const cognitoIsp = new CognitoIdentityProviderClient(config);

function getFilename(userPoolId) {
  return `${userPoolId}.json`;
}

async function listUserPools() {
  const data = await cognitoIsp.send(new ListUserPoolsCommand({ MaxResults: 60 }));
  assert(!data.NextToken, 'More than 60 user pools is not yet supported');
  const userPools = data.UserPools;
  debug({ userPools });
  return userPools.map((p) => p.Id);
}

async function backupUsers(userPoolId, file) {
  const writeStream = fs.createWriteStream(file);
  const stringify = JSONStream.stringify();

  const params = { UserPoolId: userPoolId };

  async function getUserGroupNames(user) {
    const data = await cognitoIsp.send(new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: user.Username,
    }));

    // Sleep for 20ms to avoid hitting the default 50 RPS limit on UserResourceRead
    // https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html#category_operations
    await new Promise((r) => { setTimeout(r, 20); });

    return data.Groups.map((group) => group.GroupName);
  }

  async function page() {
    debug(`Fetching users - page: ${params.PaginationToken || 'first'}`);
    const data = await cognitoIsp.send(new ListUsersCommand(params));

    const users = await pMap(data.Users, async (user) => {
      let groupNames;
      if (includeGroups === true) {
        groupNames = await getUserGroupNames(user);
      }
      return { ...user, Groups: groupNames };
    }, { concurrency });

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

async function backupGroups(userPoolId, file) {
  const writeStream = fs.createWriteStream(file);
  const stringify = JSONStream.stringify();

  const params = { UserPoolId: userPoolId, Limit: 1 };

  async function page() {
    debug(`Fetching groups - page: ${params.PaginationToken || 'first'}`);
    const data = await cognitoIsp.send(new ListGroupsCommand(params));
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

  return backupUsers(userPoolId, file);
}

function backupGroupsCli() {
  const userPoolId = cli.input[1];
  const file = getUserPoolGroupFileName(userPoolId);

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

  return backupGroups(userPoolId, file);
}

async function backupAllUsersCli() {
  const dir = cli.flags.dir || '.';

  await mkdirp(dir);
  await pMap(await listUserPools(), (userPoolId) => {
    const file = path.join(dir, getFilename(userPoolId));
    console.error(`Exporting ${userPoolId} to ${file}`);
    return backupUsers(userPoolId, file);
  }, { concurrency: 1 });
}

async function restoreUsers() {
  const userPoolId = cli.input[1];
  const tempPassword = cli.input[2];
  const file = getUserPoolFileName(userPoolId);

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

  if (!tempPassword) {
    console.error('temp-password is required');
    cli.showHelp();
  }

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

    try {
      const response = await cognitoIsp.send(new AdminCreateUserCommand(params));
      debug('Restored user', response?.User?.Username);

      if (verbose) {
        const oldSub = user.Attributes.find((attribute) => attribute.Name === 'sub');
        const newSub = response.User.Attributes.find((attribute) => attribute.Name === 'sub');
        console.log(`Restored user - oldSub: "${oldSub?.Value}" newSub: "${newSub?.Value}"`);
      }
    } catch (e) {
      if (e instanceof UsernameExistsException) {
        console.error(`Warning: UserName=${user.Username} exists and is skipped.`);
      } else {
        throw e;
      }
    }

    if (user.Groups) {
      await pMap(user.Groups, async (group) => {
        const groupParams = {
          UserPoolId: userPoolId,
          Username: user.Username,
          GroupName: group,
        };
        await cognitoIsp.send(new AdminAddUserToGroupCommand(groupParams));
        debug('Added user', user.Username, 'to group', group);
      }, { concurrency: 1 });
    }
  }, { concurrency });
}

async function restoreGroups() {
  const userPoolId = cli.input[1];
  const file = getUserPoolGroupFileName(userPoolId);

  if (!userPoolId) {
    console.error('user-pool-id is required');
    cli.showHelp();
  }

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

    try {
      const response = await cognitoIsp.send(new CreateGroupCommand(params));
      debug('Restored group', response?.Group.GroupName);
    } catch (e) {
      if (e instanceof GroupExistsException) {
        console.error(`Warning: GroupName=${group.GroupName} exists and is skipped.`);
      } else {
        throw e;
      }
    }
  }, { concurrency });
}

const methods = {
  'backup-users': backupUsersCli,
  'backup-groups': backupGroupsCli,
  'backup-all-users': backupAllUsersCli,
  'restore-users': restoreUsers,
  'restore-groups': restoreGroups,
};

const method = methods[cli.input[0]] || cli.showHelp();

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
