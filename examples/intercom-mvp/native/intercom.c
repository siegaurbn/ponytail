#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>
#include <re.h>
#include <baresip.h>
#include "intercom.h"

struct command { int op; char sip[257], digits[17], id[81]; };
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t initialized = PTHREAD_COND_INITIALIZER;
static struct mqueue *queue;
static struct ua *agent;
static struct tmr digit_timer, answer_timer;
static struct command *dialing, *answering;
static unsigned digit_index;
static bool digit_down, running, init_done;
static int init_error;
static char directory[1024], account[2048], recent[32][81];
static unsigned recent_index;
static ic_event_h emit;

static void finish(struct command *cmd, int error) {
    emit("command", cmd->sip, cmd->id, error);
    free(cmd);
}
static void answer_timeout(void *arg) {
    (void)arg;
    if (answering) { struct command *cmd = answering; answering = NULL; finish(cmd, ETIMEDOUT); }
}
static void digit_tick(void *arg) {
    (void)arg;
    struct call *call = uag_call_find(dialing->sip);
    if (!call || call_state(call) != CALL_STATE_ESTABLISHED) {
        struct command *cmd = dialing; dialing = NULL; finish(cmd, ENOTCONN); return;
    }
    int err = call_send_digit(call, digit_down ? dialing->digits[digit_index] : KEYCODE_REL);
    if (err) { struct command *cmd = dialing; dialing = NULL; finish(cmd, err); return; }
    if (!digit_down && !dialing->digits[++digit_index]) {
        struct command *cmd = dialing; dialing = NULL; finish(cmd, 0); return;
    }
    digit_down = !digit_down;
    tmr_start(&digit_timer, 120, digit_tick, NULL);
}
static void events(enum bevent_ev ev, struct bevent *event, void *arg) {
    (void)arg;
    struct call *call = bevent_get_call(event);
    const char *id = call ? call_id(call) : "";
    if (ev == BEVENT_CALL_INCOMING) {
        emit("incoming", id, "", 0);
        if (answering && !strcmp(answering->sip, id)) {
            struct command *cmd = answering; answering = NULL; tmr_cancel(&answer_timer);
            finish(cmd, ua_answer(agent, call, VIDMODE_OFF));
        }
    } else if (ev == BEVENT_CALL_ESTABLISHED) emit("established", id, "", 0);
    else if (ev == BEVENT_CALL_CLOSED) emit("closed", id, "", 0);
    else if (ev == BEVENT_REGISTER_OK) emit("registered", "", "", 0);
    else if (ev == BEVENT_REGISTER_FAIL) emit("registration_failed", "", "", EACCES);
}
static void commands(int op, void *data, void *arg) {
    (void)arg;
    struct command *cmd = data;
    struct call *call = uag_call_find(cmd->sip);
    if (op == 4) { re_cancel(); finish(cmd, 0); return; }
    if (op == 1) {
        if (!call) {
            if (answering) { finish(cmd, EBUSY); return; }
            answering = cmd; tmr_start(&answer_timer, 10000, answer_timeout, NULL); return;
        }
        if (call_state(call) != CALL_STATE_INCOMING) { finish(cmd, EINVAL); return; }
        finish(cmd, ua_answer(agent, call, VIDMODE_OFF)); return;
    }
    if (op == 2) {
        if (answering && !strcmp(answering->sip, cmd->sip)) {
            struct command *pending = answering; answering = NULL; tmr_cancel(&answer_timer); finish(pending, ECANCELED);
        }
        if (call) ua_hangup(agent, call, 0, NULL);
        finish(cmd, 0); return;
    }
    if (op != 3 || !call || call_state(call) != CALL_STATE_ESTABLISHED) { finish(cmd, ENOTCONN); return; }
    for (unsigned i = 0; i < 32; i++) if (!strcmp(recent[i], cmd->id)) { finish(cmd, EALREADY); return; }
    if (dialing) { finish(cmd, EBUSY); return; }
    strcpy(recent[recent_index++ % 32], cmd->id);
    dialing = cmd; digit_index = 0; digit_down = true; digit_tick(NULL);
}
static void *worker(void *arg) {
    (void)arg;
    int err = libre_init();
    if (!err) err = conf_path_set(directory);
    if (!err) err = conf_configure();
    if (!err) err = baresip_init(conf_config());
    if (!err) err = ua_init("Intercom MVP", true, true, false);
    if (!err) err = conf_modules();
    if (!err) err = bevent_register(events, NULL);
    if (!err) err = ua_alloc(&agent, account);
    if (!err) err = mqueue_alloc(&queue, commands, NULL);
    pthread_mutex_lock(&lock);
    init_error = err; init_done = true;
    pthread_cond_signal(&initialized); pthread_mutex_unlock(&lock);
    if (!err) { emit("ready", "", "", 0); re_main(NULL); }
    pthread_mutex_lock(&lock);
    queue = mem_deref(queue);
    pthread_mutex_unlock(&lock);
    tmr_cancel(&digit_timer); tmr_cancel(&answer_timer);
    if (dialing) { finish(dialing, ECANCELED); dialing = NULL; }
    if (answering) { finish(answering, ECANCELED); answering = NULL; }
    bevent_unregister(events); ua_close(); module_app_unload(); mod_close();
    baresip_close(); conf_close(); libre_close();
    pthread_mutex_lock(&lock); running = false; pthread_mutex_unlock(&lock);
    return NULL;
}
int ic_start(const char *config_dir, const char *aor, ic_event_h event) {
    if (!config_dir || !aor || !event || strlen(config_dir) >= sizeof directory || strlen(aor) >= sizeof account) return EINVAL;
    pthread_mutex_lock(&lock);
    if (running) { pthread_mutex_unlock(&lock); return EALREADY; }
    strcpy(directory, config_dir); strcpy(account, aor); emit = event;
    memset(recent, 0, sizeof recent); running = true; init_done = false;
    pthread_t thread;
    int err = pthread_create(&thread, NULL, worker, NULL);
    if (err) { running = false; pthread_mutex_unlock(&lock); return err; }
    pthread_detach(thread);
    while (!init_done) pthread_cond_wait(&initialized, &lock);
    err = init_error; pthread_mutex_unlock(&lock); return err;
}
int ic_command(int op, const char *sip, const char *digits, const char *id) {
    if (!sip || !digits || !id || strlen(sip) > 256 || strlen(digits) > 16 || !*id || strlen(id) > 80) return EINVAL;
    if (op == 3 && (!*digits || strspn(digits, "0123456789ABCD*#") != strlen(digits))) return EINVAL;
    struct command *cmd = calloc(1, sizeof *cmd);
    if (!cmd) return ENOMEM;
    cmd->op = op; strcpy(cmd->sip, sip); strcpy(cmd->digits, digits); strcpy(cmd->id, id);
    pthread_mutex_lock(&lock);
    int err = queue ? mqueue_push(queue, op, cmd) : ENOTCONN;
    pthread_mutex_unlock(&lock);
    if (err) free(cmd);
    return err;
}
