#ifndef INTERCOM_H
#define INTERCOM_H
#ifdef __cplusplus
extern "C" {
#endif
typedef void (*ic_event_h)(const char *type, const char *sip_id, const char *request_id, int error);
int ic_start(const char *config_dir, const char *account, ic_event_h event);
int ic_command(int operation, const char *sip_id, const char *digits, const char *request_id);
/* Operations: 1 answer, 2 hangup, 3 DTMF, 4 stop. Events arrive on the SIP thread. */
#ifdef __cplusplus
}
#endif
#endif
