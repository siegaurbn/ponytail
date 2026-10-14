package dev.ponytail.intercom;
import android.app.Application;
import android.os.Handler;
import android.os.Looper;
import android.content.SharedPreferences;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public class App extends Application {
  public static App instance;
  public SharedPreferences settings;
  public final Handler handler = new Handler(Looper.getMainLooper());
  public final ExecutorService worker = Executors.newCachedThreadPool();
  public CallManager calls;
  public MainActivity activity;
  @Override public void onCreate() {
    super.onCreate(); instance = this; settings = getSharedPreferences("intercom", MODE_PRIVATE); calls = new CallManager(this);
    if (!BuildConfig.firebaseApplicationId.isEmpty()) {
      FirebaseApp.initializeApp(this, new FirebaseOptions.Builder().setApiKey(BuildConfig.firebaseApiKey).setApplicationId(BuildConfig.firebaseApplicationId).setProjectId(BuildConfig.firebaseProjectId).setGcmSenderId(BuildConfig.firebaseSenderId).build());
      FirebaseMessaging.getInstance().getToken().addOnSuccessListener(this::registerToken);
    }
  }
  public JSONObject api(String path, JSONObject data) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) URI.create(settings.getString("api", "") + path).toURL().openConnection();
    connection.setConnectTimeout(4000); connection.setReadTimeout(6000); connection.setInstanceFollowRedirects(false);
    connection.setRequestProperty("Authorization", "Bearer " + settings.getString("token", ""));
    try {
      if (data != null) {
        connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
        try (java.io.OutputStream stream = connection.getOutputStream()) { stream.write(data.toString().getBytes(StandardCharsets.UTF_8)); }
      }
      if (connection.getResponseCode() != 200) throw new Exception("API request rejected");
      try (java.io.InputStream stream = connection.getInputStream(); java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream()) {
        byte[] buffer = new byte[4096]; int count;
        while ((count = stream.read(buffer)) != -1) { bytes.write(buffer, 0, count); if (bytes.size() > 65536) throw new Exception("Response too large"); }
        return new JSONObject(bytes.toString("UTF-8"));
      }
    } finally { connection.disconnect(); }
  }
  public void registerToken(String token) {
    settings.edit().putString("pushToken", token).apply();
    if (settings.getString("token", "").isEmpty()) return;
    worker.execute(() -> {
      try { api("/api/devices", new JSONObject().put("deviceId", settings.getString("deviceId", "")).put("platform", "android").put("token", token)); }
      catch (Exception error) { handler.post(() -> { if (activity != null) activity.notice("Не удалось зарегистрировать push"); }); }
    });
  }
}
