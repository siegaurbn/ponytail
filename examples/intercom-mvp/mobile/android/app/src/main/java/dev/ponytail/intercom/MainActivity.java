package dev.ponytail.intercom;
import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.JavascriptInterface;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;
import android.Manifest;
import java.net.URI;
import java.io.File;
import java.nio.file.Files;
import java.util.UUID;
import org.json.JSONObject;

public class MainActivity extends Activity {
  WebView web;
  @Override public void onCreate(Bundle state) {
    super.onCreate(state); App.instance.activity = this;
    requestPermissions(android.os.Build.VERSION.SDK_INT >= 33 ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS} : new String[]{Manifest.permission.RECORD_AUDIO}, 1);
    if (App.instance.settings.getString("api", "").isEmpty()) setup(); else load();
  }
  @Override protected void onDestroy() { if (App.instance.activity == this) App.instance.activity = null; if (web != null) web.destroy(); super.onDestroy(); }
  private void setup() {
    LinearLayout fields = new LinearLayout(this); fields.setOrientation(LinearLayout.VERTICAL); fields.setPadding(24,24,24,24);
    EditText url = new EditText(this), account = new EditText(this);
    url.setHint("API: https://intercom.example.com"); url.setText("http://10.0.2.2:8090");
    account.setHint("SIP account: <sip:100@pbx>;auth_pass=…;regint=300");
    fields.addView(url); fields.addView(account);
    new AlertDialog.Builder(this).setTitle("Настройка домофона").setView(fields).setPositiveButton("Сохранить", (dialog, which) -> {
      try {
        URI uri = URI.create(url.getText().toString());
        if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || uri.getHost() == null || !(uri.getPath().isEmpty() || uri.getPath().equals("/"))) throw new Exception();
        if (!uri.getScheme().equals("https") && !(uri.getScheme().equals("http") && java.util.Arrays.asList("10.0.2.2", "localhost", "127.0.0.1").contains(uri.getHost()))) throw new Exception();
        App.instance.settings.edit().putString("api", url.getText().toString().replaceAll("/$", "")).putString("account", account.getText().toString()).apply(); load();
      } catch (Exception error) { notice("Нужен HTTPS API или адрес локального эмулятора"); setup(); }
    }).setCancelable(false).show();
  }
  private void load() {
    web = new WebView(this); web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true);
    web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false);
    web.getSettings().setMediaPlaybackRequiresUserGesture(false);
    web.addJavascriptInterface(new Bridge(), "IntercomNative");
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return !request.getUrl().toString().equals(App.instance.settings.getString("api", "") + "/");
      }
    });
    setContentView(web); web.loadUrl(App.instance.settings.getString("api", "") + "/");
    App.instance.calls.startSip();
  }
  void notice(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
  void result(String id, String error) { if (web != null) web.evaluateJavascript("window.intercomResult?.(" + JSONObject.quote(id) + "," + (error == null ? "null" : JSONObject.quote(error)) + ",null)", null); }
  void event(String type, String sip) {
    try { if (web != null) web.evaluateJavascript("window.intercomEvent?.(" + new JSONObject().put("type", type).put("sipCallId", sip) + ")", null); } catch (Exception ignored) { }
  }
  class Bridge {
    @JavascriptInterface public void postMessage(String text) {
      App.instance.handler.post(() -> {
        String id = "";
        try {
          JSONObject message = new JSONObject(text); id = message.getString("id");
          if (message.getString("action").equals("configureApi")) {
            App.instance.settings.edit().putString("token", message.getString("token")).putString("deviceId", message.getString("deviceId")).apply();
            App.instance.registerToken(App.instance.settings.getString("pushToken", ""));
            String reply = id;
            App.instance.worker.execute(() -> { try { JSONObject boot = App.instance.api("/api/bootstrap", null); App.instance.settings.edit().putString("portal", boot.optString("portalUrl")).apply(); App.instance.handler.post(() -> result(reply, null)); } catch (Exception error) { App.instance.handler.post(() -> result(reply, "Не удалось подключить API")); } });
          } else if (message.getString("action").equals("portal")) {
            String target = message.getString("url");
            if (!target.equals(App.instance.settings.getString("portal", "")) || !URI.create(target).getScheme().equals("https")) throw new Exception();
            WebView portal = new WebView(MainActivity.this); portal.getSettings().setJavaScriptEnabled(true); portal.getSettings().setAllowFileAccess(false); portal.getSettings().setAllowContentAccess(false);
            portal.setWebViewClient(new WebViewClient() { @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !URI.create(target).getAuthority().equals(request.getUrl().getAuthority()) || !request.getUrl().getScheme().equals("https"); } });
            new AlertDialog.Builder(MainActivity.this).setTitle("Личный кабинет").setView(portal).setNegativeButton("Закрыть", (d,w) -> portal.destroy()).setOnDismissListener(d -> portal.destroy()).show(); portal.loadUrl(target); result(id, null);
          } else App.instance.calls.command(message);
        } catch (Exception error) { result(id, "Не удалось выполнить действие"); }
      });
    }
  }
}
