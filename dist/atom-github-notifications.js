'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.config = undefined;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

exports.activate = activate;
exports.deactivate = deactivate;
exports.serialize = serialize;
exports.fetch = fetch;
exports.reset = reset;

var _atom = require('atom');

var _bluebird = require('bluebird');

var _githubXhr = require('github-xhr');

var _githubXhr2 = _interopRequireDefault(_githubXhr);

var _ramda = require('ramda');

var R = _interopRequireWildcard(_ramda);

var _config2 = require('./config');

var _config3 = _interopRequireDefault(_config2);

var _store = require('./store');

var _constants = require('./constants');

var _messages = require('./messages');

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _toArray(arr) { return Array.isArray(arr) ? arr : Array.from(arr); }

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

var github = new _githubXhr2.default({
  protocol: 'https',
  host: 'api.github.com'
});

(0, _bluebird.promisifyAll)(github.activity);
(0, _bluebird.promisifyAll)(github.issues);
(0, _bluebird.promisifyAll)(github.pullRequests);
(0, _bluebird.promisifyAll)(github.repos);

var initialState = {
  hasPromptedForToken: false,
  lastCheckTime: 0,
  notifications: []
};
var subscriptions = null;

var store = null;

var config = exports.config = _config3.default;

function validateState(state) {
  return _extends({}, state, {
    lastCheckTime: state.lastCheckTime || 0
  });
}

function getNotificationMessage(subjectType, subjectId, subjectUrl, repoFullName, repoOwnerAvatar, userLogin) {
  var subjectDisplayName = _constants.SubjectTypeDisplayNames[subjectType];
  var subject = subjectType === _constants.NotificationSubjectTypes.COMMIT ? '[' + subjectDisplayName + ' ' + R.take(6, subjectId) + '](' + subjectUrl + ')' : '[' + subjectDisplayName + ' #' + subjectId + '](' + subjectUrl + ')';
  var message = userLogin ? 'Activity by @' + userLogin + ' on ' + subject : 'Activity on ' + subject;
  var avatarPart = '![](' + repoOwnerAvatar + '&size=17)';
  return avatarPart + ' **[' + repoFullName + ']**  \n' + message;
}

function getNotificationIcon(subjectType) {
  switch (subjectType) {
    case _constants.NotificationSubjectTypes.PULL_REQUEST:
      return 'git-pull-request';
    case _constants.NotificationSubjectTypes.COMMIT:
      return 'git-commit';
    case _constants.NotificationSubjectTypes.ISSUE:
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
  var correctedNewlineBody = body ? '  \n' + body.replace(/\r\n/g, '\n').replace(/(\S\S|\S\s|\s\S)\n/gm, '$1  \n') : '';
  return '**' + title + '**' + correctedNewlineBody;
}

function extractNotificationSubjectData(notification) {
  var commentType = void 0;
  var commentId = void 0;
  if (notification.subject.latest_comment_url) {
    var commentMatch = notification.subject.latest_comment_url.match(/.+\/(pulls|issues|commits)\/comments\/(.+)/);
    commentType = R.pathOr(null, ['1'], commentMatch);
    commentId = R.pathOr(null, ['2'], commentMatch);
  }
  var subjectId = notification.subject.url ? notification.subject.url.match(/.+\/(.+)/)[1] : 0;
  var subjectUrlType = _constants.SubjectTypeUrlString[notification.subject.type];
  var subjectUrl = 'https://github.com/' + notification.repository.full_name + '/' + subjectUrlType + '/' + subjectId;

  return {
    type: notification.subject.type,
    repo: notification.repository,
    owner: notification.repository.owner.login,
    commentId: commentId,
    commentType: commentType,
    subjectId: subjectId,
    subjectUrl: subjectUrl
  };
}

function showNotification(_ref) {
  var title = _ref.title,
      body = _ref.body,
      userLogin = _ref.userLogin,
      repoFullName = _ref.repoFullName,
      repoOwnerAvatar = _ref.repoOwnerAvatar,
      subjectId = _ref.subjectId,
      subjectUrl = _ref.subjectUrl,
      subjectType = _ref.subjectType,
      onDismiss = _ref.onDismiss;

  var notification = atom.notifications.addInfo(getNotificationMessage(subjectType, subjectId, subjectUrl, repoFullName, repoOwnerAvatar, userLogin), {
    dismissable: true,
    description: getNotificationDescription(title, body),
    icon: getNotificationIcon(subjectType)
  });
  notification.onDidDismiss(onDismiss);
}

function truncateIfTooLong(text, length) {
  // this is overly simplistic for now, ideally we should be basing this off the displayed length since many
  // characters could be markup.
  return text.length > length ? R.slice(0, _constants.MAX_MESSAGE_LENGTH, text) : text;
}

function reducer(init, deserializedState) {
  return function () {
    var state = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : _extends({}, init, deserializedState);
    var message = arguments[1];

    switch (message.type) {
      case _messages.NOTIFICATIONS_ADDED:
        return _extends({}, state, {
          lastCheckTime: message.lastCheckTime,
          notifications: R.uniqBy(function (_ref2) {
            var id = _ref2.id;
            return id;
          }, [].concat(_toConsumableArray(state.notifications), _toConsumableArray(message.notifications)))
        });
      case _messages.NOTIFICATIONS_DISPLAYED:
        return _extends({}, state, {
          notifications: R.reject(function (_ref3) {
            var id = _ref3.id;
            return R.contains(id, message.notificationIds);
          }, state.notifications)
        });
      case _messages.RESET_STATE:
        return init;
      case _messages.TOKEN_NOTIFICATION_SHOWN:
        return _extends({}, state, {
          hasPromptedForToken: true
        });
      default:
        return state;
    }
  };
}

function displayNotification(delay, notification) {
  // The GitHub notification manager seems to swallow notifications that are triggered too
  // temporally close together. This simply makes sure to display notifications separated by
  // some time so too many at once don't flood the NotificationManager.
  setTimeout(function () {
    showNotification(notification);
  }, delay);
  return delay + 750;
}

function activate(previousState) {
  var _this = this;

  // Events subscribed to in atom's system can be easily cleaned up with a CompositeDisposable
  subscriptions = new _atom.CompositeDisposable();

  store = (0, _store.createStore)(reducer(initialState, validateState(previousState)));

  store.subscribe(function () {
    var _store$getState = store.getState(),
        notifications = _store$getState.notifications;

    if (R.isEmpty(notifications)) {
      return;
    }

    R.reduce(displayNotification, 0, notifications);

    store.dispatch((0, _messages.NotificationsDisplayed)(R.map(function (_ref4) {
      var id = _ref4.id;
      return id;
    }, notifications)));
  });

  subscriptions.add(atom.commands.add('atom-workspace', {
    'atom-github-notifications:Check for new notifications': function atomGithubNotificationsCheckForNewNotifications() {
      return _this.fetch();
    },
    'atom-github-notifications:Get all unread notifications': function atomGithubNotificationsGetAllUnreadNotifications() {
      return _this.reset();
    }
  }));

  setInterval(function () {
    var _store$getState2 = store.getState(),
        lastCheckTime = _store$getState2.lastCheckTime;

    var pollInterval = atom.config.get('atom-github-notifications.pollInterval');
    if (new Date().valueOf() - lastCheckTime >= pollInterval * 60 * 1000) {
      _this.fetch();
    }
  }, _constants.STORE_TIME_INTERVAL);
  this.fetch();
}

function deactivate() {
  subscriptions.dispose();
}

function serialize() {
  return R.dissoc('hasPromptedForToken', store.getState());
}

function getFetchForCommentType(commentType) {
  switch (commentType) {
    case _constants.CommentType.COMMIT:
      return R.bind(github.repos.getCommitCommentAsync, github.repos);
    case _constants.CommentType.PULL_REQUEST:
      return R.bind(github.pullRequests.getCommentAsync, github.pullRequests);
    case _constants.CommentType.ISSUES:
      return R.bind(github.issues.getCommentAsync, github.issues);
    default:
      return null;
  }
}

function fetch() {
  var token = atom.config.get('atom-github-notifications.personalAccessToken') || process.env.GITHUB_TOKEN;
  if (!token) {
    var _store$getState3 = store.getState(),
        hasPromptedForToken = _store$getState3.hasPromptedForToken;

    if (hasPromptedForToken) {
      return;
    }

    var warning = atom.notifications.addWarning('GitHub Notifications', {
      description: "You don't seem to be setup, there are 3 steps.  \n" + 'First off we need to generate a [**Personal Access Token on GitHub**](https://github.com/settings/tokens/new?description=Atom%20GitHub%20Notifications&scopes=notifications,repo)  \n  \n' + "Next you can open the settings and paste the token you've generated into the Personal Access Token field  \n  \n" + '![Personal Access Token Field](https://raw.github.com/Axosoft/atom-github-notifications/master/resources/access-token-setting.png)',
      buttons: [{
        text: 'Open Settings',
        onDidClick: function onDidClick() {
          atom.workspace.open('atom://config/packages/atom-github-notifications');
          warning.dismiss();
        }
      }, {
        text: 'All Done',
        onDidClick: function onDidClick() {
          warning.dismiss();
        }
      }],
      dismissable: true
    });
    store.dispatch((0, _messages.TokenNotificationShown)());
    return;
  }

  github.authenticate({
    type: 'oauth',
    token: token
  });

  var onlyParticipating = atom.config.get('atom-github-notifications.showOnlyDirectParticipation');

  var newCheckTime = new Date();
  var lastCheckTime = store.getState().lastCheckTime;
  var notificationParams = { since: new Date(lastCheckTime).toISOString() };
  github.activity.getNotificationsAsync(R.merge(notificationParams, onlyParticipating ? { participating: onlyParticipating } : {})).then(function (_ref5) {
    var _ref6 = _toArray(_ref5),
        notifications = _ref6.slice(0);

    return Promise.all(R.map(function (notification) {
      var _extractNotificationS = extractNotificationSubjectData(notification),
          commentId = _extractNotificationS.commentId,
          commentType = _extractNotificationS.commentType,
          subjectId = _extractNotificationS.subjectId,
          subjectUrl = _extractNotificationS.subjectUrl,
          owner = _extractNotificationS.owner,
          repo = _extractNotificationS.repo;

      var notificationData = {
        title: notification.subject.title,
        subjectType: notification.subject.type,
        reason: notification.reason,
        commentId: commentId,
        repoFullName: repo.full_name,
        repoOwnerAvatar: repo.owner.avatar_url,
        subjectId: subjectId,
        subjectUrl: subjectUrl,
        id: notification.id,
        onDismiss: function onDismiss() {
          if (atom.config.get('atom-github-notifications.markReadOnDismiss')) {
            github.activity.markNotificationThreadAsReadAsync({
              id: notification.id
            });
          }
        }
      };

      var fetchFunction = getFetchForCommentType(commentType);
      if (fetchFunction && commentId) {
        return fetchFunction({
          user: owner,
          repo: repo.name,
          id: commentId
        }).then(function (_ref7) {
          var body = _ref7.body,
              login = _ref7.user.login;
          return _extends({}, notificationData, {
            body: truncateIfTooLong(body, _constants.MAX_MESSAGE_LENGTH),
            userLogin: login
          });
        });
      }

      return notificationData;
    }, notifications));
  }).then(function (notificationData) {
    store.dispatch((0, _messages.NotificationsAdded)(R.reject(R.isNil, notificationData), newCheckTime.valueOf()));
  }).catch(function (err) {
    store.dispatch((0, _messages.NotificationsAdded)([], newCheckTime.valueOf()));

    var message = void 0;
    try {
      message = JSON.parse(err.message).message;
    } catch (ex) {
      message = 'Failed to get error message from response:\n' + err;
    }
    atom.notifications.addError('Error communicating with GitHub', {
      dismissable: true,
      description: message
    });
  });
}

function reset() {
  store.dispatch((0, _messages.ResetState)());
  this.fetch();
}