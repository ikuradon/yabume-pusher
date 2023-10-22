import axios from "axios";
import { getUnixTime } from "date-fns";
import "dotenv/config";
import { nip19, relayInit, validateEvent, verifySignature } from "nostr-tools";
import "websocket-polyfill";
import { Redis } from "ioredis";
import * as Bolt11 from "bolt11";

const RELAY_URL = process.env.RELAY_URL;
const PUSH_URL = process.env.PUSH_URL;
const PUSH_TOKEN = process.env.PUSH_TOKEN;

const ACCEPT_DUR_SEC = 5 * 60;

const redis = new Redis(process.env.REDIS_URL);

const currUnixtime = () => getUnixTime(new Date());

const KINDS = {
  SHORT_TEXT_NOTE: 1,
  ENCRYPTED_DIRECT_MESSAGE: 4,
  CHANNEL_MESSAGE: 42,
  ZAP: 9735,
};

const publishMessage = async (topic, title, message, tags, actions) => {
  const headers = {
    Authorization: "Bearer " + PUSH_TOKEN,
  };
  await axios
    .post(PUSH_URL, { topic, title, message, tags, actions }, { headers })
    .then((response) => {
      console.log("OK!");
    })
    .catch((error) => {
      console.log(error.response.data);
    });
};

const checkEnabled = async (pubkey, kind) => {
  const key = `push-${pubkey}-${kind}`;
  try {
    const value = await redis.get(key);
    if (value === "1") {
      return true;
    }
  } catch (err) {
    console.error(err);
    return false;
  }
  return false;
};

const main = async () => {
  const relay = relayInit(RELAY_URL);
  relay.on("error", () => {
    console.error("failed to connect");
    process.exit(0);
  });

  relay.connect();

  const subNote = relay.sub([
    {
      kinds: [KINDS.SHORT_TEXT_NOTE, KINDS.CHANNEL_MESSAGE],
      since: currUnixtime(),
    },
  ]);
  const subDM = relay.sub([
    { kinds: [KINDS.ENCRYPTED_DIRECT_MESSAGE], since: currUnixtime() },
  ]);
  const subZap = relay.sub([{ kinds: [KINDS.ZAP], since: currUnixtime() }]);

  subNote.on("event", (ev) => {
    if (ev.created_at < currUnixtime() - ACCEPT_DUR_SEC) return false;

    if (!!ev.tags) {
      const tagList = ev.tags;
      tagList
        .filter(
          (record) => record[0] === "p" && record[1].match(/[0-9a-f]{64}/gi)
        )
        .forEach((record) => {
          try {
            const receiverNpub = nip19.npubEncode(record[1]);
            const senderNpub = nip19.npubEncode(ev.pubkey);
            const nevent = nip19.neventEncode({
              id: ev.id,
              relays: [RELAY_URL],
              author: ev.pubkey,
            });
            const message = ev.content;

            console.log(`[NOTE] to: ${receiverNpub}, message: ${message}`);
            publishMessage(
              receiverNpub,
              "Reply from: " + senderNpub,
              message,
              ["vibration_mode"],
              [
                {
                  action: "view",
                  label: "View",
                  url: "https://yabu.me/" + nevent,
                  clear: true,
                },
              ]
            );
          } catch (e) {
            console.log(e);
          }
        });
    }
  });

  subDM.on("event", async (ev) => {
    if (ev.created_at < currUnixtime() - ACCEPT_DUR_SEC) return false;

    if (!!ev.tags) {
      const tagList = ev.tags;
      for (let record of tagList.filter(
        (x) => x[0] === "p" && x[1].match(/[0-9a-f]{64}/gi)
      )) {
        try {
          const receiverHex = record[1];

          const receiverNpub = nip19.npubEncode(receiverHex);
          const senderNpub = nip19.npubEncode(ev.pubkey);
          console.log(`[DM] to: ${receiverNpub}`);

          if (await checkEnabled(receiverHex, KINDS.ENCRYPTED_DIRECT_MESSAGE)) {
            console.log(`Enabled user`);

            publishMessage(
              receiverNpub,
              "Direct Message from: " + senderNpub,
              "Encrypted",
              ["incoming_envelope"],
              []
            );
          }
        } catch (e) {
          console.log(e);
        }
      }
    }
  });

  subZap.on("event", async (ev) => {
    if (ev.created_at < currUnixtime() - ACCEPT_DUR_SEC) return false;

    if (!!ev.tags) {
      try {
        const tagList = ev.tags;
        const pTag = tagList.find(([t, v]) => t === "p" && v);
        if (!pTag) throw new Error("Zap request doesn't have a 'p' tag.");
        if (!pTag[1].match(/^[a-f0-9]{64}$/))
          throw new Error("Zap request 'p' tag is not valid hex.");
        const receiverHex = pTag[1];

        const bolt11Tag = tagList.find(([t, v]) => t === "bolt11" && v);
        if (!bolt11Tag)
          throw new Error("Zap request doesn't have a 'bolt11' tag.");
        const bolt11 = Bolt11.decode(bolt11Tag[1]);
        const zapAmount = bolt11.satoshis;
        const descTag = tagList.find(([t, v]) => t === "description" && v);
        if (!descTag)
          throw new Error("Zap request doesn't have a 'description' tag.");
        const descEvent = JSON.parse(descTag[1]);
        if (!validateEvent(descEvent) || !verifySignature(descEvent))
          throw new Error("'description' tags data is broken.");

        const senderHex = descEvent.pubkey;
        const zapMessage = descEvent.content;

        let anonZap = false;
        if (descEvent.tags.filter(([t, v]) => t === "anon").length === 1)
          anonZap = true;

        const receiverNpub = nip19.npubEncode(receiverHex);
        const senderNpub = nip19.npubEncode(senderHex);
        console.log(`[Zap] to: ${receiverNpub}`);

        if (await checkEnabled(receiverHex, KINDS.ZAP)) {
          console.log(`Enabled user`);

          const title = !anonZap
            ? `Zap⚡ from: ${senderNpub}`
            : "Someone send zap⚡";
          let message = `amount: ${zapAmount}`;
          message += !!zapMessage ? `\nmessage: ${zapMessage}` : "";
          publishMessage(receiverNpub, title, message, ["zap"], []);
        }
      } catch (e) {
        console.log(e);
      }
    }
  });
};

main().catch((e) => console.error(e));
