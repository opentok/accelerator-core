/* global OT */

/** Dependencies */
const logging = require('./logging');
const state = require('./state');
const { dom, path, properCase } = require('./util');

let session;
let accPack;
let callProperties;
let screenProperties;
let streamContainers;
let autoSubscribe;
let connectionLimit;
let active = false;

/**
 * Default UI propties
 * https://tokbox.com/developer/guides/customize-ui/js/
 */
const defaultCallProperties = {
  insertMode: 'append',
  width: '100%',
  height: '100%',
  showControls: false,
  style: {
    buttonDisplayMode: 'off',
  },
};

/**
 * Trigger an event through the API layer
 * @param {String} event - The name of the event
 * @param {*} [data]
 */
const triggerEvent = (event, data) => accPack.triggerEvent(event, data);

/**
 * Determine whether or not the party is able to join the call based on
 * the specified connection limit, if any.
 * @return {Boolean}
 */
const ableToJoin = () => {
  if (!connectionLimit) {
    return true;
  }
  const cameraStreams = Object.values(state.getStreams()).filter(s => s.videoType === 'camera');
  return cameraStreams.length < connectionLimit;
};

/**
 * Create a camera publisher object
 * @returns {Promise} <resolve: Object, reject: Error>
 */
const createPublisher = () =>
  new Promise((resolve, reject) => {
    // TODO: Handle adding 'name' option to props
    const props = Object.assign({}, callProperties);
    // TODO: Figure out how to handle common vs package-specific options
    const container = dom.element(streamContainers('publisher', 'camera'));
    const publisher = OT.initPublisher(container, props, (error) => {
      error ? reject(error) : resolve(publisher);
    });
  });


/**
 * Publish the local camera stream and update state
 * @returns {Promise} <resolve: empty, reject: Error>
 */
const publish = () =>
  new Promise((resolve, reject) => {
    createPublisher()
      .then((publisher) => {
        state.addPublisher('camera', publisher);
        session.publish(publisher);
        logging.log(logging.logAction.startCall, logging.logVariation.success);
        resolve();
      })
      .catch((error) => {
        logging.log(logging.logAction.startCall, logging.logVariation.fail);
        const errorMessage = error.code === 1010 ? 'Check your network connection' : error.message;
        triggerEvent('error', errorMessage);
        reject(error);
      });
  });

/**
 * Subscribe to a stream and update the state
 * @param {Object} stream - An OpenTok stream object
 * @returns {Promise} <resolve: empty reject: Error >
 */
const subscribe = stream =>
  new Promise((resolve, reject) => {
    logging.log(logging.logAction.subscribe, logging.logVariation.attempt);
    const streamMap = state.getStreamMap();
    if (streamMap[stream.id]) {
      // Are we already subscribing to the stream?
      resolve();
    } else {
      const type = stream.videoType;
      const connectionData = JSON.parse(path(['connection', 'data'], stream) || null);
      const container = dom.query(streamContainers('subscriber', type, connectionData));
      const options = type === 'camera' ? callProperties : screenProperties;
      const subscriber = session.subscribe(stream, container, options, (error) => {
        if (error) {
          logging.log(logging.logAction.subscribe, logging.logVariation.fail);
          reject(error);
        } else {
          state.addSubscriber(subscriber);
          triggerEvent(`subscribeTo${properCase(type)}`, Object.assign({}, { subscriber }, state.all()));
          type === 'screen' && triggerEvent('startViewingSharedScreen', subscriber); // Legacy event
          logging.log(logging.logAction.subscribe, logging.logVariation.success);
          resolve();
        }
      });
    }
  });

/**
 * Unsubscribe from a stream and update the state
 * @param {Object} subscriber - An OpenTok subscriber object
 * @returns {Promise} <resolve: empty>
 */
const unsubscribe = subscriber =>
  new Promise((resolve) => {
    logging.log(logging.logAction.unsubscribe, logging.logVariation.attempt);
    session.unsubscribe(subscriber);
    state.removeSubscriber(subscriber);
    logging.log(logging.logAction.unsubscribe, logging.logVariation.success);
    resolve();
  });

/**
 * Ensure all required options are received
 * @param {Object} options
 */
const validateOptions = (options) => {
  const requiredOptions = ['session', 'publishers', 'subscribers', 'streams', 'accPack'];

  requiredOptions.forEach((option) => {
    if (!options[option]) {
      logging.error(`${option} is a required option.`);
    }
  });

  session = options.session;
  accPack = options.accPack;
  streamContainers = options.streamContainers;
  callProperties = options.callProperties || defaultCallProperties;
  connectionLimit = options.connectionLimit || null;
  autoSubscribe = options.hasOwnProperty('autoSubscribe') ? options.autoSubscribe : true;


  screenProperties = options.screenProperties ||
    Object.assign({}, defaultCallProperties, { videoSource: 'window' });
};

/**
 * Subscribe to new stream unless autoSubscribe is set to false
 * @param {Object} stream
 */
const onStreamCreated = ({ stream }) => active && autoSubscribe && subscribe(stream);

/**
 * Update state and trigger corresponding event(s) when stream is destroyed
 * @param {Object} stream
 */
const onStreamDestroyed = ({ stream }) => {
  state.removeStream(stream);
  const type = stream.videoType;
  type === 'screen' && triggerEvent('endViewingSharedScreen'); // Legacy event
  triggerEvent(`unsubscribeFrom${properCase(type)}`, state.getPubSub());
};

/**
 * Listen for API-level events
 */
const createEventListeners = () => {
  accPack.on('streamCreated', onStreamCreated);
  accPack.on('streamDestroyed', onStreamDestroyed);
};

/**
 * Start publishing the local camera feed and subscribing to streams in the session
 * @returns {Promise} <resolve: Object, reject: Error>
 */
const startCall = () =>
  new Promise((resolve, reject) => {
    logging.log(logging.logAction.startCall, logging.logVariation.attempt);
    if (!ableToJoin()) {
      const errorMessage = 'Session has reached its connection limit';
      triggerEvent('error', errorMessage);
      logging.log(logging.logAction.startCall, logging.logVariation.fail);
      return reject(new Error(errorMessage));
    }
    publish()
      .then(() => {
        const streams = state.getStreams();
        const initialSubscriptions = Object.keys(streams).map(id => subscribe(streams[id]));
        Promise.all(initialSubscriptions).then(() => {
          const pubSubData = state.getPubSub();
          triggerEvent('startCall', pubSubData);
          active = true;
          resolve(pubSubData);
        }).catch(reason => logging.message(`Failed to subscribe to all existing streams: ${reason}`));
      });
  });

/**
 * Stop publishing and unsubscribe from all streams
 */
const endCall = () => {
  logging.log(logging.logAction.endCall, logging.logVariation.attempt);
  const { publishers } = state.getPubSub();
  const unpublish = publisher => session.unpublish(publisher);
  Object.keys(publishers.camera).forEach(id => unpublish(publishers.camera[id]));
  Object.keys(publishers.screen).forEach(id => unpublish(publishers.screen[id]));
  state.removeAllPublishers();
  state.removeAllSubscribers();
  active = false;
  logging.log(logging.logAction.endCall, logging.logVariation.success);
};

/**
 * Enable/disable local audio or video
 * @param {String} source - 'audio' or 'video'
 * @param {Boolean} enable
 */
const enableLocalAV = (id, source, enable) => {
  const method = `publish${properCase(source)}`;
  const { publishers } = state.getPubSub();
  publishers.camera[id][method](enable);
};

/**
 * Enable/disable remote audio or video
 * @param {String} subscriberId
 * @param {String} source - 'audio' or 'video'
 * @param {Boolean} enable
 */
const enableRemoteAV = (subscriberId, source, enable) => {
  const method = `subscribeTo${properCase(source)}`;
  const { subscribers } = state.getPubSub();
  subscribers.camera[subscriberId][method](enable);
};

/**
 * Initialize the communication component
 * @param {Object} options
 * @param {Object} options.session
 * @param {Object} options.publishers
 * @param {Object} options.subscribers
 * @param {Object} options.streams
 * @param {Number} options.connectionLimit
 * @param {Function} options.streamContainer
 */
const init = options =>
  new Promise((resolve) => {
    validateOptions(options);
    createEventListeners();
    resolve();
  });


/** Exports */
module.exports = {
  init,
  startCall,
  endCall,
  subscribe,
  unsubscribe,
  enableLocalAV,
  enableRemoteAV,
};
