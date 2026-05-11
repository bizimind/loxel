import { deleteSecret, getSecret, setSecret } from "../src/index.ts";

const SERVICE = "com.bizimind.keychain-test";
const ACCOUNT = "compile-test";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
}

// Clean up any leftover state from a previous run
deleteSecret(SERVICE, ACCOUNT);

// set + get roundtrip
const key = Buffer.from("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "hex");
setSecret(SERVICE, ACCOUNT, key);
const got = getSecret(SERVICE, ACCOUNT);
assert(got !== null, "getSecret returns non-null after setSecret");
assert(got!.toString("hex") === key.toString("hex"), "getSecret returns exact bytes written");

// overwrite (upsert)
const key2 = Buffer.from("cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe", "hex");
setSecret(SERVICE, ACCOUNT, key2);
const got2 = getSecret(SERVICE, ACCOUNT);
assert(got2!.toString("hex") === key2.toString("hex"), "setSecret overwrites existing entry");

// delete
const deleted = deleteSecret(SERVICE, ACCOUNT);
assert(deleted === true, "deleteSecret returns true for existing item");

// get after delete
const gone = getSecret(SERVICE, ACCOUNT);
assert(gone === null, "getSecret returns null after deleteSecret");

// delete non-existent
const deletedAgain = deleteSecret(SERVICE, ACCOUNT);
assert(deletedAgain === false, "deleteSecret returns false for missing item");

console.log("\nAll tests passed.");
