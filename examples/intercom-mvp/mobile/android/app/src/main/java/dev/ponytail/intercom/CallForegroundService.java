package dev.ponytail.intercom;
import android.app.*;
import android.content.*;
import android.os.IBinder;
public class CallForegroundService extends Service {
  @Override public IBinder onBind(Intent intent) { return null; }
  @Override public int onStartCommand(Intent intent, int flags, int id) {
    PendingIntent show = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
    PendingIntent answer = PendingIntent.getService(this, 1, new Intent(this, CallForegroundService.class).setAction("answer"), PendingIntent.FLAG_IMMUTABLE);
    PendingIntent end = PendingIntent.getService(this, 2, new Intent(this, CallForegroundService.class).setAction("end"), PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder notification = new Notification.Builder(this, "calls").setSmallIcon(android.R.drawable.sym_call_incoming).setContentTitle("Вызов домофона").setContentIntent(show).setCategory(Notification.CATEGORY_CALL).setOngoing(true);
    if (android.os.Build.VERSION.SDK_INT >= 31) notification.setStyle(Notification.CallStyle.forIncomingCall(new Person.Builder().setName("Домофон").build(), end, answer));
    else notification.addAction(new Notification.Action.Builder(null, "Ответить", answer).build()).addAction(new Notification.Action.Builder(null, "Завершить", end).build());
    startForeground(1, notification.build());
    if (intent != null && "answer".equals(intent.getAction())) App.instance.calls.answer();
    if (intent != null && "end".equals(intent.getAction())) App.instance.calls.hangup();
    return START_NOT_STICKY;
  }
}
