import type { Store } from "./db";

export function deletionPolicy(db: Store, user: string) {
  const last = !db.prepare('SELECT 1 FROM "user" WHERE id<>? LIMIT 1').get(user);
  const admin = !!db.prepare("SELECT 1 FROM administrators WHERE user_id=?").get(user);
  const otherAdmin = !!db.prepare('SELECT 1 FROM administrators a JOIN "user" u ON u.id=a.user_id WHERE a.user_id<>? LIMIT 1').get(user);
  return {
    last_account: last,
    has_password: !!db.prepare('SELECT 1 FROM "account" WHERE userId=? AND providerId=\'credential\' AND password IS NOT NULL LIMIT 1').get(user),
    blocked_reason: admin && !last && !otherAdmin ? "The administrator account can't be deleted while other accounts remain." : null,
  };
}
