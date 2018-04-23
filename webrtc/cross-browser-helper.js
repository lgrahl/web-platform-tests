'use strict';

/**
 * A future similar to Python's asyncio.Future. Allows to resolve or reject
 * outside of the executor.
 */
class Future extends Promise {
  constructor(executor) {
    let resolve, reject;
    super((resolve_, reject_) => {
      resolve = resolve_;
      reject = reject_;
      if (executor) {
        return executor(resolve_, reject_);
      }
    });

    this._resolve = resolve;
    this._reject = reject;
  }

  resolve(...args) {
    return this._resolve(...args);
  }

  reject(...args) {
    return this._reject(...args);
  }
}

class Signaling {
  /**
   * Create a signalling instance.
   * @param {Test} test The test instance.
   */
  constructor(test) {
    test.add_cleanup(() => this._close());
    this._test = test;
    this._pendingInboundMessages = [];
    this._remoteDescriptionFuture = null;
    this._remoteCandidateHandler = null;
    this._remoteDataHandler = null;
    this._doneSent = false;
    this._remoteDoneFuture = new Future();
  }

  /**
   * High-level helper to automatically send all local candidates to the remote
   * peer and feed all remote candidates to the local peer connection.
   *
   * @param {Test} test The test instance.
   * @param {RTCPeerConnection} pc The local peer connection.
   */
  exchangeCandidates(test, pc) {
    // Bind local candidate events
    pc.addEventListener('icecandidate', (event) => {
      const { candidate } = event;
      if (candidate) {
        this.sendLocalCandidate(candidate)
      }
    });

    // Bind remote candidate events
    this.onRemoteCandidate = (candidate) => {
      pc.addIceCandidate(candidate).catch((error) => assert_unreached(
        `(Signaling) Adding a remote candidate failed: ${error}`));
    };
  }

  /**
   * High-level helper that does the offer/answer exchange process for you
   * depending on the role.
   *
   * @param {RTCPeerConnection} pc The local peer connection.
   * @param {boolean} offering Whether the local peer is offering or not.
   * @returns {Promise<void>} A promise resolving once the exchange process
   * has completed.
   */
  async exchangeDescriptions(pc, offering) {
    if (offering) {
      // Create offer
      let offer = await pc.createOffer();

      // Apply and send offer
      await pc.setLocalDescription(offer);
      this.sendLocalDescription(offer);
    }

    // Wait for the remote description and apply it once received
    const description = await this.receiveRemoteDescription();
    await pc.setRemoteDescription(description);

    if (!offering) {
      // Create answer
      let answer = await pc.createAnswer();

      // Apply and send answer
      await pc.setLocalDescription(answer);
      this.sendLocalDescription(answer);
    }
  }

  /**
   * Wait for a remote description.
   * @returns {Promise<RTCSessionDescriptionInit>}
   */
  receiveRemoteDescription() {
    if (this._remoteDescriptionFuture === null) {
      this._remoteDescriptionFuture = new Future();
    }
    this._processPendingInboundMessages();
    return this._remoteDescriptionFuture;
  }

  /**
   * Bind a remote candidate event handler.
   * @param handler
   */
  set onRemoteCandidate(handler) {
    this._remoteCandidateHandler = handler;
    this._processPendingInboundMessages();
  }

  /**
   * Bind a remote custom data handler.
   * @param handler
   */
  set onRemoteData(handler) {
    this._remoteDataHandler = handler;
    this._processPendingInboundMessages();
  }

  /**
   * Send a local description to the remote peer.
   * @param {RTCSessionDescriptionInit} description The local description.
   */
  sendLocalDescription(description) {
    // Send local description
    this._sendMessage({type: 'description', value: description});
  }

  /**
   * Send a local candidate to the remote peer.
   * @param {RTCIceCandidate} candidate The local candidate.
   */
  sendLocalCandidate(candidate) {
    this._sendMessage({type: 'candidate', value: candidate});
  }

  /**
   * Send custom data to the remote peer.
   * @param {*} data Custom data which must be serialisable.
   */
  sendData(data) {
    this._sendMessage({type: 'data', value: data});
  }

  _done(result) {
    if (!this._doneSent) {
      this._sendMessage({type: 'done', value: result});
      this._doneSent = true;
    }
    return this._remoteDoneFuture;
  }

  /**
   * Close the signalling connection (if any).
   */
  _close() {
    // Does nothing by default
  }

  _sendMessage(message) {
    assert_unreached('(Signaling) You need to implement this!');
  }

  _receiveMessage(message) {
    // Validate message
    if (!('type' in message)) {
      assert_unreached("(Signaling) Invalid message, did not contain a 'type' field");
      return;
    }
    if (!('value' in message)) {
      message.value = null;
    }

    // Handle message
    switch (message.type) {
      case 'description':
        this._handleRemoteDescription(message);
        break;
      case 'candidate':
        this._handleRemoteCandidate(message);
        break;
      case 'data':
        this._handleData(message);
        break;
      case 'done':
        this._handleDone(message);
        break;
      default:
        assert_unreached(`(Signaling) Unknown message type: ${message.type}`);
        break;
    }
  }

  _handleRemoteDescription(message) {
    // Resolve future or enqueue
    const future = this._remoteDescriptionFuture;
    if (future === null) {
      this._pendingInboundMessages.push(message);
      return;
    }
    this._remoteDescriptionFuture = null;
    future.resolve(message.value);
  }

  _handleRemoteCandidate(message) {
    // Call handler or enqueue
    if (this._remoteCandidateHandler === null) {
      this._pendingInboundMessages.push(message);
      return;
    }
    this._remoteCandidateHandler(message.value);
  }

  _handleData(message) {
    // Call handler or enqueue
    if (this._remoteDataHandler === null) {
      this._pendingInboundMessages.push(message);
      return;
    }
    this._remoteDataHandler(message.value);
  }

  _handleDone(message) {
    // Resolve future
    this._remoteDoneFuture.resolve(message.value);
  }

  _processPendingInboundMessages() {
    // Receive all pending messages
    const messages = this._pendingInboundMessages;
    this._pendingInboundMessages = [];
    for (const message of messages) {
      this._receiveMessage(message);
    }
  }
}

/**
 * Loopback signalling can be used when a browser creates two peer
 * connections that talk to each other.
 */
class LoopbackSignaling extends Signaling {
  /**
   * Create a loopback signalling instance.
   * @param {Test} test The test instance.
   */
  constructor(test) {
    super(test);
    this.other = null;
  }

  _sendMessage(message) {
    this.other._receiveMessage(message);
  }
}

/**
 * A signalling implementation intended for this signalling server:
 * https://github.com/lgrahl/silly-signaling
 *
 * Example: `ws://localhost/path/0` when offering, and
 *          `ws://localhost/path/1` when answering.
 */
class WebSocketSignaling extends Signaling {
  /**
   * Create a WebSocket signalling instance.
   * @param {Test} test The test instance.
   * @param {string} signalingServerUrl The WebSocket URL.
   */
  constructor(test, signalingServerUrl) {
    super(test);
    this._pendingOutboundMessages = [];

    // Create WebSocket connection
    let ws;
    try {
      ws = new WebSocket(signalingServerUrl);
    } catch (error) {
      assert_unreached(`(Signaling) Couldn't create WebSocket: ${error}`);
    }
    ws.onopen = () => {
      for (const message of this._pendingOutboundMessages) {
        this._sendMessage(message);
      }
    };
    ws.onerror = test.step_func(() => {
      assert_unreached('(Signaling) WebSocketSignaling error event fired');
    });
    ws.onmessage = (event) => {
      this._receiveMessage(JSON.parse(event.data));
    };

    // Store WebSocket instance
    this.ws = ws;
  }

  _sendMessage(message) {
    // Cache if not open, yet.
    if (this.ws.readyState !== 1) {
      this._pendingOutboundMessages.push(message);
      return;
    }

    // Send
    this.ws.send(JSON.stringify(message));
  }

  _close() {
    super._close();
    this.ws.close();
  }
}

// Parse URL parameters
const params = new URLSearchParams(document.location.search);
const crossBrowserEnabled = params.get('crossBrowser') !== null;
const signalingServerBaseUrl = params.get('signalingServer');
const role = (params.get('role') === '1') ? 1 : 0;

// In cross-browser mode, wait for the other browser and reset the global tests timeout
const readyFuture = new Future();
if (crossBrowserEnabled) {
  const signalingServerUrl = `${signalingServerBaseUrl}/are-you-there?/${role}`;
  const ws = new WebSocket(signalingServerUrl);
  ws.onopen = () => {
    ws.send('');
  };
  ws.onmessage = () => {
    // Rendezvous complete, reset global timeout
    reset_global_timeout();
    readyFuture.resolve();
    ws.close();
  };
} else {
  readyFuture.resolve();
}

function cross_browser_test(func, name, properties) {
  promise_test(async (test) => {
    // Clear any timeout handler running (yup, yet another ugly hack, sorry!)
    // Note: We intentionally don't clear 'test.timeout_id' here since this would potentially
    //       re-apply `setTimeout` in a subsequent call to `.step()` of the test instance.
    await Promise.resolve();
    clearTimeout(test.timeout_id);

    // Wait for both browsers to be ready & reset test timeout
    await readyFuture;
    test.timeout_id = null;
    test.set_timeout();

    if (crossBrowserEnabled) {
      // Prepare signaling URL
      if (signalingServerBaseUrl === null) {
        assert_unreached('(Signaling) Base URL not supplied in URL parameters');
      }
      const signalingServerUrl = `${signalingServerBaseUrl}/${test.index}/${role}`;

      // Create WebSocket signalling
      const signaling = new WebSocketSignaling(test, signalingServerUrl);

      // Hold back .done() and synchronise error messages
      // Note 1: Yep, this is quite an ugly hack.
      // Note 2: In case the remote peer doesn't answer, .done() may never be called on the test.
      //         However, testharness seems to handle it quite well and even calls cleanup functions.
      const done = test.done;
      test.done = async () => {
        // Send the local status and get the remote status
        const status = test.phase <= test.phases.STARTED ? test.PASS : test.status;
        const local = {
          status: status,
          message: status !== test.PASS ? test.message : null,
        };
        const remote = await signaling._done(local);

        // If remote's test did not 'PASS', set our status to 'FAIL'
        if (local.status === test.PASS && remote.status !== test.PASS) {
          test.set_status(test.FAIL, `(Remote) ${remote.message}`);
          test.phase = test.phases.HAS_RESULT;
        }

        // Call the actual done method
        done.call(test);
      };

      // Wait for both peers to complete the test function
      await func(test, signaling, role === 1);
    } else {
      // Create loopback signalling for both peers and glue them together
      const signaling1 = new LoopbackSignaling(test);
      const signaling2 = new LoopbackSignaling(test);
      signaling1.other = signaling2;
      signaling2.other = signaling1;

      // Run the test function for both peers
      await Promise.all([
        func(test, signaling1, true),
        func(test, signaling2, false),
      ]);
    }
  }, name, properties);
}
