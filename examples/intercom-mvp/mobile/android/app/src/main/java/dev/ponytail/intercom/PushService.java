package dev.ponytail.intercom;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import org.json.JSONObject;
public class PushService extends FirebaseMessagingService {
  @Override public void onNewToken(String token) { App.instance.registerToken(token); }
  @Override public void onMessageReceived(RemoteMessage message) {
    JSONObject data = new JSONObject(message.getData());
    App.instance.handler.post(() -> App.instance.calls.incoming(data));
  }
}
