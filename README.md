# cognito-backup 👫→💾
Amazon doesn't have any way of backing up their AWS Cognito User Pools.
cognito-backup is a CLI for backing up the data. <b>Note: AWS has no way of extracting the passwords of your users so you need to store these separately 😵</b>

<a target='_blank' rel='nofollow' href='https://app.codesponsor.io/link/a3DabSrJLUgh3DWQzN9s8KRM/mifi/cognito-backup'>
  <img alt='Sponsor' width='888' height='68' src='https://app.codesponsor.io/embed/a3DabSrJLUgh3DWQzN9s8KRM/mifi/cognito-backup.svg' />
</a>

## Install
```
npm install -g cognito-backup
```

## Usage
```
cognito-backup backup-users <user-pool-id> <options>  Backup all users in a single user pool
cognito-backup backup-all-users <options>  Backup all users in all user pools for this account
```

## Examples
```
cognito-backup backup-users eu-west-1_1_12345
cognito-backup backup-users eu-west-1_1_12345 --region eu-west-1 --file mypool.json
cognito-backup backup-all-users eu-west-1_1_12345 --region eu-west-1 --dir output
```

## TODO
- Implement restore
