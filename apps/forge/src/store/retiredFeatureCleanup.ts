import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const RETIRED_SPEECH_SECRET = "speech-secrets.json";

/** Removes the credential owned exclusively by the retired read-aloud feature. */
export function removeRetiredSpeechCredential(stateDirectory: string): void {
  const secretsDirectory = join(stateDirectory, "secrets");
  const directory = lstatSync(secretsDirectory, { throwIfNoEntry: false });
  if (!directory) return;
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error(`Refusing to follow unexpected legacy secrets path: ${secretsDirectory}`);
  }

  const credentialPath = join(secretsDirectory, RETIRED_SPEECH_SECRET);
  const credential = lstatSync(credentialPath, { throwIfNoEntry: false });
  if (!credential) return;
  if (!credential.isFile() && !credential.isSymbolicLink()) {
    throw new Error(`Refusing to remove unexpected legacy credential path: ${credentialPath}`);
  }

  // unlink removes a symlink itself rather than following its target.
  unlinkSync(credentialPath);
  if (readdirSync(secretsDirectory).length === 0) rmdirSync(secretsDirectory);
}
