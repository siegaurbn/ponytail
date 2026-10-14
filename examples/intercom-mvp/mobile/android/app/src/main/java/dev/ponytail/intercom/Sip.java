package dev.ponytail.intercom;
import org.json.JSONObject;
public final class Sip {
  static { System.loadLibrary("intercom"); }
  public static native int start(String directory, String account);
  public static native int command(int operation, String sipCallId, String digits, String requestId);
  public static void event(String type, String sipCallId, String requestId, int error) {
    App.instance.handler.post(() -> App.instance.calls.event(type, sipCallId, requestId, error));
  }
}
