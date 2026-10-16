/**
 * Detect automated spam uploads that use generic usernames + OS + public IP.
 * Legitimate clients use real usernames or indexed names like `0081_5_27_Administrator`.
 */

const SPAM_USERNAMES = new Set([
  'administrator',
  'user',
  'ubuntu',
  'john',
  'alice',
  'dev',
  'root',
]);

const SPAM_FOLDER_RE =
  /^(Administrator|user|ubuntu|john|alice|dev|root)_(linux|mac|win)_/i;

/** True when the reported username is a known spam identity. */
export function isSpamUsername(username: unknown): boolean {
  const name = String(username || '').trim().toLowerCase();
  return name.length > 0 && SPAM_USERNAMES.has(name);
}

/** True when a project-env folder name matches the spam pattern. */
export function isSpamProjectEnvFolder(folderName: string): boolean {
  return SPAM_FOLDER_RE.test(String(folderName || '').trim());
}
