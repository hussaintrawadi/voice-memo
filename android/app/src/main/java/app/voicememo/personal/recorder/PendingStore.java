package app.voicememo.personal.recorder;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Recordings waiting to be uploaded. Each one is an .m4a file plus a small .json
 * sidecar in the app's private storage, so nothing is lost if the app is killed or offline.
 */
public final class PendingStore {

    private static final String PREFS = "voice_memo";

    public static final class Item {
        public String id;
        public long recordedAt;
        public double durationSec;
        public long bytes;
        public String partOf;
        public int partIndex;
        public int attempts;
        public String lastError;
        public boolean blocked;
        /** Loudest moment, 0–1; -1 when unknown. */
        public double peak = -1;

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("recordedAt", recordedAt);
            o.put("durationSec", durationSec);
            o.put("bytes", bytes);
            o.put("partOf", partOf);
            o.put("partIndex", partIndex);
            o.put("attempts", attempts);
            o.put("lastError", lastError == null ? JSONObject.NULL : lastError);
            o.put("blocked", blocked);
            o.put("peak", peak);
            return o;
        }

        static Item fromJson(JSONObject o) {
            Item i = new Item();
            i.id = o.optString("id");
            i.recordedAt = o.optLong("recordedAt");
            i.durationSec = o.optDouble("durationSec", 0);
            i.bytes = o.optLong("bytes");
            i.partOf = o.optString("partOf", null);
            i.partIndex = o.optInt("partIndex");
            i.attempts = o.optInt("attempts");
            i.lastError = o.isNull("lastError") ? null : o.optString("lastError", null);
            i.blocked = o.optBoolean("blocked");
            i.peak = o.optDouble("peak", -1);
            return i;
        }
    }

    private PendingStore() {}

    public static File dir(Context context) {
        File dir = new File(context.getFilesDir(), "recordings");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    public static File audioFile(Context context, String id) {
        return new File(dir(context), id + ".m4a");
    }

    private static File metaFile(Context context, String id) {
        return new File(dir(context), id + ".json");
    }

    public static synchronized void save(Context context, Item item) throws IOException {
        try {
            byte[] data = item.toJson().toString().getBytes(StandardCharsets.UTF_8);
            File tmp = new File(dir(context), item.id + ".json.tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(data);
                out.getFD().sync();
            }
            if (!tmp.renameTo(metaFile(context, item.id))) throw new IOException("Could not save recording details");
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    public static synchronized List<Item> list(Context context) {
        List<Item> items = new ArrayList<>();
        File[] files = dir(context).listFiles((d, name) -> name.endsWith(".json"));
        if (files == null) return items;
        for (File f : files) {
            try (FileInputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[(int) f.length()];
                int read = in.read(buf);
                JSONObject o = new JSONObject(new String(buf, 0, Math.max(read, 0), StandardCharsets.UTF_8));
                Item item = Item.fromJson(o);
                if (audioFile(context, item.id).exists()) items.add(item);
                else f.delete();
            } catch (IOException | JSONException ignored) {
                // A half-written sidecar is skipped; the audio stays until the next save.
            }
        }
        Collections.sort(items, (a, b) -> Long.compare(a.recordedAt, b.recordedAt));
        return items;
    }

    public static synchronized void delete(Context context, String id) {
        audioFile(context, id).delete();
        metaFile(context, id).delete();
    }

    public static synchronized void unblockAll(Context context) {
        for (Item item : list(context)) {
            if (!item.blocked) continue;
            item.blocked = false;
            item.lastError = null;
            try {
                save(context, item);
            } catch (IOException ignored) {
            }
        }
    }

    // ── Upload configuration ─────────────────────────────────────────────────

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void setConfig(Context context, String baseUrl, String captureToken) {
        prefs(context).edit().putString("baseUrl", baseUrl).putString("captureToken", captureToken).apply();
    }

    public static String baseUrl(Context context) {
        return prefs(context).getString("baseUrl", null);
    }

    public static String captureToken(Context context) {
        return prefs(context).getString("captureToken", null);
    }
}
