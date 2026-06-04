const twilio = require("twilio");
const config = require("../config");
const Logger = require("../utils/logger");

const log = new Logger("TwilioClient");

class TwilioClient {
  #client;
  constructor() { this.#client = twilio(config.twilio.accountSid, config.twilio.authToken); }

  async makeCall(toNumber) {
    const call = await this.#client.calls.create({
      to: toNumber,
      from: config.twilio.phoneNumber,
      url: `${config.ngrokUrl}/api/twilio-answer`,
      statusCallback: `${config.ngrokUrl}/api/twilio-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    log.info(`Outbound call initiated — SID: ${call.sid}`);
    return { sid: call.sid };
  }

  buildAnswerTwiML() {
    const host = config.ngrokUrl.replace(/^https?:\/\//, "");
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="callerPhone" value="{{From}}" />
    </Stream>
  </Connect>
</Response>`;
  }
}

module.exports = new TwilioClient();
