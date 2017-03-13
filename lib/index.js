// @flow

import { CompositeDisposable } from 'atom';
import { promisifyAll } from 'bluebird';
import GitHubApi from 'github-xhr';
import * as R from 'ramda';

import { createStore } from './store';
import _config from './config';

import {
  CommentType,
  NotificationSubjectTypes,
  SubjectTypeDisplayNames,
  SubjectTypeUrlString,
  STORE_TIME_INTERVAL,
} from './constants';

import {
  NotificationsAdded,
  NotificationsDisplayed,
  ResetState,
  TokenNotificationShown,
} from './messages';

const github = new GitHubApi({
  protocol: 'https',
  host: 'api.github.com',
});

promisifyAll(github.activity);
promisifyAll(github.issues);
promisifyAll(github.pullRequests);
promisifyAll(github.repos);

let subscriptions = null;

let store = null;

export const config = _config;

function getNotificationMessage(
  subjectType,
  subjectId,
  subjectUrl,
  repoFullName,
  repoOwnerAvatar,
  userLogin,
) {
  const subjectDisplayName = SubjectTypeDisplayNames[subjectType];
  const subject = subjectType === NotificationSubjectTypes.COMMIT
    ? `[${subjectDisplayName} ${R.take(6, subjectId)}](${subjectUrl})`
    : `[${subjectDisplayName} #${subjectId}](${subjectUrl})`;
  const message = userLogin ? `Activity by @${userLogin} on ${subject}` : `Activity on ${subject}`;
  const avatarPart = `![](${repoOwnerAvatar}&size=17)`;
  return `${avatarPart} **[${repoFullName}]**  \n${message}`;
}

function getNotificationIcon(subjectType) {
  switch (subjectType) {
    case NotificationSubjectTypes.PULL_REQUEST:
      return 'git-pull-request';
    case NotificationSubjectTypes.COMMIT:
      return 'git-commit';
    case NotificationSubjectTypes.ISSUE:
      return 'issue-opened';
    default:
      return null;
  }
}

function getNotificationDescription(title, body) {
  // GitHub sends down body with `{text}\r\n{more text}\r\n{yet more}` but when rendered using
  // atom's markdown generator, plain newlines not preceded by spaces are swallowed up. To fix this,
  // we replace \r\n's with just \n's and add in two spaces to before the \n to force it to render
  // newlines properly.
  //
  // EX:
  //    foo\r\nbar\r\nmore lines
  //          becomes
  //    foo  \nbar  \nmorelines
  const correctedNewlineBody = body
    ? `  \n${body.replace(/\r\n/g, '\n').replace(/(\S\S|\S\s|\s\S)\n/gm, '$1  \n')}`
    : '';
  return `**${title}**${correctedNewlineBody}`;
}

function extractNotificationSubjectData(notification) {
  let commentType;
  let commentId;
  if (notification.subject.latest_comment_url) {
    const commentMatch = notification.subject.latest_comment_url.match(
      /.+\/(pulls|issues|commits)\/comments\/(.+)/,
    );
    commentType = R.pathOr(null, ['1'], commentMatch);
    commentId = R.pathOr(null, ['2'], commentMatch);
  }
  const subjectId = notification.subject.url ? notification.subject.url.match(/.+\/(.+)/)[1] : 0;
  const subjectUrlType = SubjectTypeUrlString[notification.subject.type];
  const subjectUrl = `https://github.com/${notification.repository.full_name}/${subjectUrlType}/${subjectId}`;

  return {
    type: notification.subject.type,
    repo: notification.repository,
    owner: notification.repository.owner.login,
    commentId,
    commentType,
    subjectId,
    subjectUrl,
  };
}

function showNotification(
  {
    title,
    body,
    userLogin,
    repoFullName,
    repoOwnerAvatar,
    subjectId,
    subjectUrl,
    subjectType,
    onDismiss,
  },
) {
  const notification = atom.notifications.addInfo(
    getNotificationMessage(
      subjectType,
      subjectId,
      subjectUrl,
      repoFullName,
      repoOwnerAvatar,
      userLogin,
    ),
    {
      dismissable: true,
      description: getNotificationDescription(title, body),
      icon: getNotificationIcon(subjectType),
    },
  );
  notification.onDidDismiss(onDismiss);
}

function displayNotification(delay, notification) {
  // The GitHub notification manager seems to swallow notifications that are triggered too
  // temporally close together. This simply makes sure to display notifications separated by
  // some time so too many at once don't flood the NotificationManager.
  setTimeout(
    () => {
      showNotification(notification);
    },
    delay,
  );
  return delay + 750;
}

export function activate(previousState) {
  // Events subscribed to in atom's system can be easily cleaned up with a CompositeDisposable
  subscriptions = new CompositeDisposable();

  store = createStore(previousState);

  store.subscribe(() => {
    const { notifications } = store.getState();

    if (R.isEmpty(notifications)) {
      return;
    }

    R.reduce(displayNotification, 0, notifications);

    store.dispatch(NotificationsDisplayed(R.map(({ id }) => id, notifications)));
  });

  subscriptions.add(
    atom.commands.add('atom-workspace', {
      'atom-github-notifications:Check for new notifications': () => this.fetch(),
      'atom-github-notifications:Get all unread notifications': () => this.reset(),
    }),
  );

  setInterval(
    () => {
      const { lastCheckTime } = store.getState();
      const pollInterval = atom.config.get('atom-github-notifications.pollInterval');
      if (new Date().valueOf() - lastCheckTime >= pollInterval * 60 * 1000) {
        this.fetch();
      }
    },
    STORE_TIME_INTERVAL,
  );
  this.fetch();
}

export function deactivate() {
  subscriptions.dispose();
}

export function serialize() {
  return R.dissoc('hasPromptedForToken', store.getState());
}

function getFetchForCommentType(commentType) {
  switch (commentType) {
    case CommentType.COMMIT:
      return R.bind(github.repos.getCommitCommentAsync, github.repos);
    case CommentType.PULL_REQUEST:
      return R.bind(github.pullRequests.getCommentAsync, github.pullRequests);
    case CommentType.ISSUES:
      return R.bind(github.issues.getCommentAsync, github.issues);
    default:
      return null;
  }
}

export function fetch() {
  const token = atom.config.get('atom-github-notifications.personalAccessToken');
  if (!token) {
    const { hasPromptedForToken } = store.getState();

    if (hasPromptedForToken) {
      return;
    }

    const warning = atom.notifications.addWarning('GitHub Notifications', {
      description: 'You need to add a `Personal Access Token` to get notifications from GitHub',
      buttons: [
        {
          text: 'Go add one',
          onDidClick: () => {
            atom.workspace.open('atom://config/packages/atom-github-notifications');
            warning.dismiss();
          },
        },
      ],
      dismissable: true,
    });
    store.dispatch(TokenNotificationShown());
    return;
  }

  github.authenticate({
    type: 'oauth',
    token,
  });

  const onlyParticipating = atom.config.get(
    'atom-github-notifications.showOnlyDirectParticipation',
  );

  const newCheckTime = new Date();
  const lastCheckTime = store.getState().lastCheckTime;
  const notificationParams = { since: new Date(lastCheckTime).toISOString() };
  github.activity
    .getNotificationsAsync(
      R.merge(notificationParams, onlyParticipating ? { participating: onlyParticipating } : {}),
    )
    .then(([...notifications]) => Promise.all(
      R.map(
        (notification) => {
          const {
            commentId,
            commentType,
            subjectId,
            subjectUrl,
            owner,
            repo,
          } = extractNotificationSubjectData(notification);
          const notificationData = {
            title: notification.subject.title,
            subjectType: notification.subject.type,
            reason: notification.reason,
            commentId,
            repoFullName: repo.full_name,
            repoOwnerAvatar: repo.owner.avatar_url,
            subjectId,
            subjectUrl,
            id: notification.id,
            onDismiss: () => {
              if (atom.config.get('atom-github-notifications.markReadOnDismiss')) {
                github.activity.markNotificationThreadAsReadAsync({ id: notification.id });
              }
            },
          };

          const fetchFunction = getFetchForCommentType(commentType);
          if (fetchFunction && commentId) {
            return fetchFunction({ user: owner, repo: repo.name, id: commentId }).then((
              { body, user: { login } },
            ) => ({
              ...notificationData,
              body,
              userLogin: login,
            }));
          }

          return notificationData;
        },
        notifications,
      ),
    ))
    .then((notificationData) => {
      store.dispatch(
        NotificationsAdded(R.reject(R.isNil, notificationData), newCheckTime.valueOf()),
      );
    })
    .catch((err) => {
      store.dispatch(NotificationsAdded([], newCheckTime.valueOf()));

      let message;
      try {
        message = JSON.parse(err.message).message;
      } catch (ex) {
        message = `Failed to get error message from response:\n${err}`;
      }
      atom.notifications.addError('Error communicating with GitHub', {
        dismissable: true,
        description: message,
      });
    });
}

export function reset() {
  store.dispatch(ResetState());
  this.fetch();
}