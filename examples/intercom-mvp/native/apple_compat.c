#include <errno.h>
#include <re.h>

/* libre 4.12's Apple backend lacks this symbol; per-account client certs are unsupported. */
int tls_add_certf(struct tls *tls, const char *certf, const char *host) {
    (void)tls; (void)certf; (void)host;
    return ENOSYS;
}
