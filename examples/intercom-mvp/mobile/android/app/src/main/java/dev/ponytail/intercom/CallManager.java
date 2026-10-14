package dev.ponytail.intercom;
import android.telecom.*;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.app.*;
import android.Manifest;
import android.content.pm.PackageManager;
import java.io.File;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

public class CallManager {
  final App app;
  final PhoneAccountHandle handle;
  JSONObject call;
  Connection connection;
  boolean starting;
  final Map<String, java.util.function.Consumer<String>> completions = new HashMap<>();
  public CallManager(App app) {
    this.app = app; handle = new PhoneAccountHandle(new ComponentName(app, CallsService.class), "intercom");
    app.getSystemService(TelecomManager.class).registerPhoneAccount(new PhoneAccount.Builder(handle, "Домофон").setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED).build());
    app.getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("calls", "Вызовы домофона", NotificationManager.IMPORTANCE_HIGH));
  }
  void startSip() {
    if (starting || app.settings.getString("account", "").isEmpty()) return;
    starting = true;
    app.worker.execute(() -> {
      try {
        File directory = new File(app.getFilesDir(), "sip"); directory.mkdirs();
        Files.write(new File(directory, "config").toPath(), ("audio_player aaudio,default\naudio_source aaudio,default\nmodule g711\nmodule aaudio\nmodule auconv\nmodule auresamp\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        int error = Sip.start(directory.getPath(), app.settings.getString("account", ""));
        if (error != 0 && error != 114) app.handler.post(() -> { if (app.activity != null) app.activity.notice("SIP не подключён: " + error); });
      } catch (Exception error) { app.handler.post(() -> { if (app.activity != null) app.activity.notice("Не удалось запустить SIP"); }); }
      finally { app.handler.post(() -> starting = false); }
    });
  }
  void incoming(JSONObject data) {
    try {
      if (data.getLong("expiresAt") <= System.currentTimeMillis() || call != null) return;
      UUID.fromString(data.getString("callId"));
      data.getString("sipCallId"); call = data; startSip();
      Bundle extras = new Bundle(); extras.putString("callId", data.getString("callId"));
      app.startForegroundService(new Intent(app, CallForegroundService.class));
      app.getSystemService(TelecomManager.class).addNewIncomingCall(handle, extras);
      poll();
    } catch (Exception error) { close(); }
  }
  void poll() {
    if (call == null) return;
    String id = call.optString("callId");
    app.worker.execute(() -> {
      try {
        JSONObject state = app.api("/api/calls/" + id, null).getJSONObject("call");
        app.handler.post(() -> {
          if (call == null || !call.optString("callId").equals(id)) return;
          if (!state.optString("sipCallId").equals(call.optString("sipCallId")) || state.optString("state").equals("ended") || state.optLong("expiresAt") <= System.currentTimeMillis() || (state.has("deviceId") && !state.optString("deviceId").equals(app.settings.getString("deviceId", "")))) { hangup(); return; }
          app.handler.postDelayed(this::poll, 2000);
        });
      } catch (Exception error) { app.handler.post(this::hangup); }
    });
  }
  void answer() {
    if (call == null || app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { hangup(); return; }
    JSONObject current = call;
    app.worker.execute(() -> {
      try {
        app.api("/api/calls/" + current.getString("callId") + "/answer", new JSONObject().put("deviceId", app.settings.getString("deviceId", "")));
        app.handler.post(() -> { try { command(new JSONObject().put("id", UUID.randomUUID().toString()).put("action", "answer").put("callId", current.getString("callId")).put("sipCallId", current.getString("sipCallId"))); } catch (Exception error) { hangup(); } });
      } catch (Exception error) { app.handler.post(this::hangup); }
    });
  }
  void command(JSONObject data) throws Exception {
    String action = data.getString("action"), id = data.getString("id"), sip = data.getString("sipCallId");
    int op = action.equals("answer") ? 1 : action.equals("end") ? 2 : action.equals("dtmf") ? 3 : 0;
    if (op == 0) throw new Exception();
    if (op == 1 && call == null) call = new JSONObject().put("callId", data.getString("callId")).put("sipCallId", sip);
    int error = Sip.command(op, sip, data.optString("digits"), op == 3 ? data.getString("requestId") : id);
    String commandId = op == 3 ? data.getString("requestId") : id;
    completions.put(commandId, failure -> { if (app.activity != null) app.activity.result(id, failure); });
    app.handler.postDelayed(() -> { java.util.function.Consumer<String> pending = completions.remove(commandId); if (pending != null) pending.accept("SIP не ответил"); }, 12000);
    if (error != 0) { completions.remove(op == 3 ? data.getString("requestId") : id); if (app.activity != null) app.activity.result(id, "SIP действие недоступно: " + error); }
  }
  void event(String type, String sip, String id, int error) {
    if (type.equals("command")) {
      java.util.function.Consumer<String> completion = completions.remove(id);
      if (completion != null) completion.accept(error == 0 ? null : "SIP ошибка: " + error);
      if (error != 0) { if (app.activity != null) app.activity.notice("SIP действие завершилось с ошибкой: " + error); if (connection != null && connection.getState() != Connection.STATE_ACTIVE) hangup(); }
    }
    if (call != null && call.optString("sipCallId").equals(sip)) {
      if (type.equals("established")) {
        if (connection != null) connection.setActive();
        String callId = call.optString("callId");
        app.worker.execute(() -> { try { app.api("/api/calls/" + callId + "/active", new JSONObject().put("deviceId", app.settings.getString("deviceId", ""))); } catch (Exception error2) { app.handler.post(this::hangup); } });
      } else if (type.equals("closed")) close();
    }
    if (app.activity != null) app.activity.event(type, sip);
  }
  void hangup() {
    if (call == null) return;
    Sip.command(2, call.optString("sipCallId"), "", UUID.randomUUID().toString());
    String id = call.optString("callId");
    app.worker.execute(() -> { try { app.api("/api/calls/" + id + "/end", new JSONObject().put("deviceId", app.settings.getString("deviceId", ""))); } catch (Exception ignored) { } });
    close();
  }
  void close() {
    if (connection != null) { connection.setDisconnected(new DisconnectCause(DisconnectCause.LOCAL)); connection.destroy(); connection = null; }
    call = null; app.stopService(new Intent(app, CallForegroundService.class));
  }
}
