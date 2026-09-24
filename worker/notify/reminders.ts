import { errorMessage, now } from "../lib/util";
import { pushConfigured, sendPush } from "./fcm";

interface DueReminder {
  id: string;
  user_id: string;
  text: string;
  recording_id: string | null;
}

/**
 * Runs every minute: claims reminders that are due and pushes them to the user's phones.
 * The Mac app schedules its own notifications from the reminders list, so it needs no push.
 */
export async function sendDueReminders(env: Env) {
  // Claim in one statement so an overlapping run can't send the same reminder twice.
  const { results: due } = await env.DB.prepare(
    `UPDATE reminders SET status = 'sent', sent_at = ?1, updated_at = ?1
     WHERE id IN (SELECT id FROM reminders WHERE status = 'pending' AND remind_at <= ?2 ORDER BY remind_at LIMIT 50)
     RETURNING id, user_id, text, recording_id`,
  )
    .bind(now(), now() + 30_000)
    .all<DueReminder>();
  if (!due.length || !pushConfigured(env)) return;

  const userIds = [...new Set(due.map((r) => r.user_id))];
  const { results: devices } = await env.DB.prepare(
    `SELECT id, user_id, token FROM push_devices WHERE user_id IN (${userIds.map(() => "?").join(", ")})`,
  )
    .bind(...userIds)
    .all<{ id: string; user_id: string; token: string }>();

  const retry: string[] = [];
  const dead = new Set<string>();
  for (const reminder of due) {
    const targets = devices.filter((d) => d.user_id === reminder.user_id && !dead.has(d.id));
    let delivered = false;
    let transient = false;
    for (const device of targets) {
      try {
        const outcome = await sendPush(env, {
          token: device.token,
          title: "Reminder",
          body: reminder.text,
          tag: reminder.id,
          data: { reminderId: reminder.id, url: reminder.recording_id ? `/r/${reminder.recording_id}` : "/" },
        });
        if (outcome === "sent") delivered = true;
        else if (outcome === "unregistered") dead.add(device.id);
        else if (outcome === "retry") transient = true;
      } catch (err) {
        transient = true;
        console.error("push failed", errorMessage(err));
      }
    }
    // Every phone was temporarily unreachable: try again next minute.
    if (!delivered && transient) retry.push(reminder.id);
  }

  const statements: D1PreparedStatement[] = [...dead].map((id) => env.DB.prepare("DELETE FROM push_devices WHERE id = ?").bind(id));
  for (const id of retry) {
    statements.push(env.DB.prepare("UPDATE reminders SET status = 'pending', sent_at = NULL WHERE id = ?").bind(id));
  }
  if (statements.length) await env.DB.batch(statements);
}
