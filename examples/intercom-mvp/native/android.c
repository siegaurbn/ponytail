#include <jni.h>
#include "intercom.h"
static JavaVM *vm;
static jclass bridge;
static jmethodID callback;
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *value, void *reserved) {
    (void)reserved; vm = value; return JNI_VERSION_1_6;
}
static void event(const char *type, const char *sip, const char *id, int error) {
    JNIEnv *env;
    int detached = (*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) == JNI_EDETACHED;
    if (detached && (*vm)->AttachCurrentThread(vm, &env, NULL)) return;
    jstring t = (*env)->NewStringUTF(env, type), s = (*env)->NewStringUTF(env, sip), r = (*env)->NewStringUTF(env, id);
    (*env)->CallStaticVoidMethod(env, bridge, callback, t, s, r, error);
    (*env)->DeleteLocalRef(env, t); (*env)->DeleteLocalRef(env, s); (*env)->DeleteLocalRef(env, r);
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
    if (detached) (*vm)->DetachCurrentThread(vm);
}
JNIEXPORT jint JNICALL Java_dev_ponytail_intercom_Sip_start(JNIEnv *env, jclass cls, jstring dir, jstring aor) {
    if (!bridge) { bridge = (*env)->NewGlobalRef(env, cls); callback = (*env)->GetStaticMethodID(env, cls, "event", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I)V"); }
    const char *d = (*env)->GetStringUTFChars(env, dir, NULL), *a = (*env)->GetStringUTFChars(env, aor, NULL);
    int error = ic_start(d, a, event);
    (*env)->ReleaseStringUTFChars(env, dir, d); (*env)->ReleaseStringUTFChars(env, aor, a); return error;
}
JNIEXPORT jint JNICALL Java_dev_ponytail_intercom_Sip_command(JNIEnv *env, jclass cls, jint op, jstring sip, jstring digits, jstring id) {
    (void)cls;
    const char *s = (*env)->GetStringUTFChars(env, sip, NULL), *d = (*env)->GetStringUTFChars(env, digits, NULL), *r = (*env)->GetStringUTFChars(env, id, NULL);
    int error = ic_command(op, s, d, r);
    (*env)->ReleaseStringUTFChars(env, sip, s); (*env)->ReleaseStringUTFChars(env, digits, d); (*env)->ReleaseStringUTFChars(env, id, r); return error;
}
