package dev.ponytail.intercom;
import android.telecom.*;
import android.net.Uri;
public class CallsService extends ConnectionService {
  @Override public Connection onCreateIncomingConnection(PhoneAccountHandle handle, ConnectionRequest request) {
    CallManager manager = App.instance.calls;
    if (manager.call == null) return Connection.createFailedConnection(new DisconnectCause(DisconnectCause.ERROR));
    Connection connection = new Connection() {
      @Override public void onAnswer() { manager.answer(); }
      @Override public void onReject() { manager.hangup(); }
      @Override public void onDisconnect() { manager.hangup(); }
      @Override public void onShowIncomingCallUi() { startForegroundService(new android.content.Intent(CallsService.this, CallForegroundService.class)); }
    };
    connection.setConnectionProperties(Connection.PROPERTY_SELF_MANAGED); connection.setAudioModeIsVoip(true);
    connection.setAddress(Uri.parse("sip:intercom"), TelecomManager.PRESENTATION_ALLOWED);
    connection.setCallerDisplayName(manager.call.optString("name", "Домофон"), TelecomManager.PRESENTATION_ALLOWED);
    connection.setRinging(); manager.connection = connection; return connection;
  }
  @Override public void onCreateIncomingConnectionFailed(PhoneAccountHandle handle, ConnectionRequest request) { App.instance.calls.hangup(); }
}
