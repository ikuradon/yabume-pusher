import { nip19, relayInit } from "nostr-tools";
import "websocket-polyfill";
import "dotenv/config";
import axios from "axios";

const RELAY_URL = process.env.RELAY_URL;
const PUSH_URL = process.env.PUSH_URL;
const PUSH_TOKEN = process.env.PUSH_TOKEN;

const main = async () => {
  const relay = relayInit(RELAY_URL);
  relay.on("error", () => {
    console.error("failed to connect");
  });

  relay.connect();

  const sub = relay.sub([{ kinds: [1], limit: 1 }]);

  sub.on("event", (ev) => {
    if (!!ev.tags) {
      const tagList = ev.tags;
      tagList.filter(record => (record[0] === "p" && record[1].match(/[0-9a-f]{64}/gi))).forEach(record => {
        try {
          const npub = nip19.npubEncode(record[1]);
          const note = nip19.noteEncode(ev.id);
          const message = ev.content;

          const headers = {
            Authorization: "Bearer " + PUSH_TOKEN,
          };
          console.log(`to: ${npub}, message: ${message}`);
          axios.post(
            PUSH_URL,
            {
              topic: npub,
              title: "Reply from: " + npub,
              message: message,
              tags: ["vibration_mode"],
              actions: [
                {
                  action: "view",
                  label: "View",
                  url: "https://yabu.me/" + note,
                  clear: true,
                },
              ]
            },
            {
              headers: headers,
            }
          ).then(response => {
            console.log("OK!");
          }).catch(error => {
            console.log(error.response.data);
          });
        } catch (e) {
          console.log(e);
        }
      });
    }
  });
};

main().catch((e) => console.error(e));