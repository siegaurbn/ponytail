#include <errno.h>
#include <re.h>

/* shortcut: libre 4.12 omits this Apple symbol; remove when its TLS stubs include it. */
int tls_add_certf(struct tls *tls, const char *certf, const char *host) {
    (void)tls; (void)certf; (void)host;
    return ENOSYS;
}
