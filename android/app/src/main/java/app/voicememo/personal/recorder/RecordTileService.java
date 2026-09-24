package app.voicememo.personal.recorder;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import app.voicememo.personal.MainActivity;

/** Quick Settings tile: tap to start recording, tap again to stop and save. */
public class RecordTileService extends TileService implements RecorderState.Listener {

    @Override
    public void onStartListening() {
        RecorderState.addListener(this);
        refresh();
    }

    @Override
    public void onStopListening() {
        RecorderState.removeListener(this);
    }

    @Override
    public void onClick() {
        if (RecorderState.state() != RecorderState.State.IDLE) {
            RecorderService.send(this, RecorderService.ACTION_STOP);
            return;
        }
        // Android only lets an app start using the microphone from the foreground,
        // so open the app with a "record now" request.
        Intent intent = new Intent(this, MainActivity.class)
            .setAction(MainActivity.ACTION_RECORD)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        } else {
            startActivityAndCollapseCompat(intent);
        }
    }

    @SuppressWarnings("deprecation")
    private void startActivityAndCollapseCompat(Intent intent) {
        startActivityAndCollapse(intent);
    }

    private void refresh() {
        Tile tile = getQsTile();
        if (tile == null) return;
        boolean active = RecorderState.state() != RecorderState.State.IDLE;
        tile.setState(active ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.setLabel(active ? "Stop memo" : "Record memo");
        tile.updateTile();
    }

    @Override
    public void onStateChanged() {
        refresh();
    }

    @Override
    public void onQueueChanged() {}
}
