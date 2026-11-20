// mail-bridge: lets mail apps reach xstate's Worker (docs/imap-smtp-relay-plan.md, 3.1).
//
// Workers can't accept raw TCP from the internet yet, so this listens on the mail ports, ends TLS, and copies the
// bytes to and from one WebSocket per connection (wss://api.xstate.com/relay/imap or /relay/smtp). It doesn't read
// IMAP or SMTP, apart from the few plain-text lines before STARTTLS on port 587. It writes nothing to disk and logs
// no content: only counts, sizes and addresses.
//
// Frames. Binary frames carry the connection's bytes, both ways. Text frames are control:
//
//	bridge → session  "ack <n>"  the mail app has taken n bytes in total (flow control: the session sends at most
//	                             a window ahead of the last ack, so a slow mail app can't fill its memory)
//	session → bridge  "close"    close the connection after everything sent before it is written
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const (
	readChunk    = 32 * 1024        // most bytes of the mail app's sent in one frame
	ackEvery     = 256 * 1024       // an ack goes out each time this many more bytes were written to the mail app
	maxFrame     = 1 << 20          // largest frame accepted from the session (it sends 64 KB ones)
	pingEvery    = 50 * time.Second // keeps the WebSocket open through idle hours, and notices a dead upstream
	writeTimeout = 2 * time.Minute  // a mail app that takes nothing for this long is dropped
)

var (
	upstream   = flag.String("upstream", env("BRIDGE_UPSTREAM", "wss://api.xstate.com/relay"), "WebSocket base URL; /imap or /smtp is added")
	hostname   = flag.String("hostname", env("BRIDGE_HOSTNAME", "mail.xstate.com"), "name used in the SMTP lines before STARTTLS")
	certFile   = flag.String("cert", env("BRIDGE_CERT", ""), "TLS certificate chain (PEM)")
	keyFile    = flag.String("key", env("BRIDGE_KEY", ""), "TLS private key (PEM)")
	secretFile = flag.String("secret-file", env("BRIDGE_SECRET_FILE", ""), "file holding the secret the Worker expects (or set BRIDGE_SECRET)")
	imaps      = flag.String("imaps", env("BRIDGE_IMAPS", ""), "listen address for IMAP over TLS, e.g. :993")
	smtps      = flag.String("smtps", env("BRIDGE_SMTPS", ""), "listen address for SMTP over TLS, e.g. :465")
	submission = flag.String("submission", env("BRIDGE_SUBMISSION", ""), "listen address for SMTP with STARTTLS, e.g. :587")
	maxConns   = flag.Int("max-conns", 4000, "most connections open at once")
	maxPerIP   = flag.Int("max-per-ip", 40, "most connections open at once from one address")
	idle       = flag.Duration("idle", 30*time.Minute, "close a connection the mail app has been silent on for this long")
)

var (
	secret  string
	open    atomic.Int64
	total   atomic.Int64
	perIP   = map[string]int{}
	perIPMu sync.Mutex
)

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.LUTC)
	secret = strings.TrimSpace(os.Getenv("BRIDGE_SECRET"))
	if *secretFile != "" {
		b, err := os.ReadFile(*secretFile)
		if err != nil {
			log.Fatalf("secret file: %v", err)
		}
		secret = strings.TrimSpace(string(b))
	}
	if secret == "" {
		log.Fatal("no secret: set BRIDGE_SECRET or -secret-file")
	}
	if *certFile == "" || *keyFile == "" {
		log.Fatal("no certificate: set -cert and -key")
	}
	certs := &certLoader{}
	if _, err := certs.get(nil); err != nil {
		log.Fatalf("certificate: %v", err)
	}
	tlsConfig := &tls.Config{GetCertificate: certs.get, MinVersion: tls.VersionTLS12}

	listening := 0
	for _, l := range []struct {
		addr, proto string
		startTLS    bool
	}{
		{*imaps, "imap", false}, {*smtps, "smtp", false}, {*submission, "smtp", true},
	} {
		if l.addr == "" {
			continue
		}
		ln, err := net.Listen("tcp", l.addr)
		if err != nil {
			log.Fatalf("listen %s: %v", l.addr, err)
		}
		log.Printf("listening on %s (%s, starttls=%v)", l.addr, l.proto, l.startTLS)
		listening++
		go accept(ln, l.proto, l.startTLS, tlsConfig)
	}
	if listening == 0 {
		log.Fatal("nothing to listen on: set -imaps, -smtps or -submission")
	}

	go func() {
		var m runtime.MemStats
		for range time.Tick(time.Minute) {
			runtime.ReadMemStats(&m)
			log.Printf("stats open=%d total=%d heap_mb=%.1f sys_mb=%.1f goroutines=%d", open.Load(), total.Load(),
				float64(m.HeapInuse)/1e6, float64(m.Sys)/1e6, runtime.NumGoroutine())
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("stopping with %d connections open", open.Load())
}

// certLoader re-reads the certificate when its file changes, so a certbot renewal needs no restart.
type certLoader struct {
	mu      sync.Mutex
	cert    *tls.Certificate
	modTime time.Time
}

func (c *certLoader) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	info, err := os.Stat(*certFile)
	if err != nil {
		if c.cert != nil {
			return c.cert, nil
		}
		return nil, err
	}
	if c.cert == nil || info.ModTime().After(c.modTime) {
		cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
		if err != nil {
			if c.cert != nil {
				log.Printf("certificate reload failed, keeping the old one: %v", err)
				return c.cert, nil
			}
			return nil, err
		}
		c.cert, c.modTime = &cert, info.ModTime()
	}
	return c.cert, nil
}

func accept(ln net.Listener, proto string, startTLS bool, tlsConfig *tls.Config) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go serve(conn, proto, startTLS, tlsConfig)
	}
}

func serve(raw net.Conn, proto string, startTLS bool, tlsConfig *tls.Config) {
	defer raw.Close()
	ip, _, _ := net.SplitHostPort(raw.RemoteAddr().String())
	if !admit(ip) {
		return
	}
	defer release(ip)
	total.Add(1)
	started := time.Now()

	if startTLS {
		if err := beforeStartTLS(raw); err != nil {
			return
		}
	}
	client := tls.Server(raw, tlsConfig)
	handshake, cancelHandshake := context.WithTimeout(context.Background(), 15*time.Second)
	err := client.HandshakeContext(handshake)
	cancelHandshake()
	if err != nil {
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mode := "implicit"
	if startTLS {
		mode = "starttls"
	}
	dial, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	ws, _, err := websocket.Dial(dial, *upstream+"/"+proto+"?tls="+mode, &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Relay-Secret": {secret}, "X-Client-IP": {ip}},
	})
	cancelDial()
	if err != nil {
		log.Printf("upstream %s: %v", proto, err)
		client.SetWriteDeadline(time.Now().Add(5 * time.Second))
		switch {
		case proto == "imap":
			io.WriteString(client, "* BYE Service unavailable, try again later\r\n")
		case !startTLS:
			io.WriteString(client, "421 4.3.0 Service unavailable, try again later\r\n")
		}
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(maxFrame)

	var in, out atomic.Int64
	done := make(chan string, 3)

	// Mail app → session.
	go func() {
		buf := make([]byte, readChunk)
		for {
			client.SetReadDeadline(time.Now().Add(*idle))
			n, err := client.Read(buf)
			if n > 0 {
				in.Add(int64(n))
				if werr := ws.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
					done <- "upstream"
					return
				}
			}
			if err != nil {
				if errors.Is(err, os.ErrDeadlineExceeded) {
					done <- "idle"
				} else {
					done <- "client"
				}
				return
			}
		}
	}()

	// Session → mail app.
	go func() {
		var acked int64
		for {
			kind, data, err := ws.Read(ctx)
			if err != nil {
				done <- "upstream"
				return
			}
			if kind == websocket.MessageText {
				if string(data) == "close" {
					done <- "session"
					return
				}
				continue
			}
			client.SetWriteDeadline(time.Now().Add(writeTimeout))
			if _, err := client.Write(data); err != nil {
				done <- "client"
				return
			}
			written := out.Add(int64(len(data)))
			if written-acked >= ackEvery {
				acked = written
				if err := ws.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf("ack %d", written))); err != nil {
					done <- "upstream"
					return
				}
			}
		}
	}()

	// Keep-alive. The Workers runtime answers pings itself, without waking the session.
	go func() {
		t := time.NewTicker(pingEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pingCtx, cancelPing := context.WithTimeout(ctx, 20*time.Second)
				err := ws.Ping(pingCtx)
				cancelPing()
				if err != nil {
					done <- "upstream"
					return
				}
			}
		}
	}()

	why := <-done
	cancel()
	ws.Close(websocket.StatusNormalClosure, "")
	log.Printf("closed proto=%s ip=%s by=%s secs=%d in=%d out=%d", proto, ip, why, int(time.Since(started).Seconds()), in.Load(), out.Load())
}

// beforeStartTLS speaks the plain-text lines an SMTP client sends before STARTTLS on port 587: the only SMTP the
// bridge knows. Nothing else is accepted in plain text, so a password can never cross unencrypted.
func beforeStartTLS(conn net.Conn) error {
	conn.SetDeadline(time.Now().Add(60 * time.Second))
	defer conn.SetDeadline(time.Time{})
	if _, err := fmt.Fprintf(conn, "220 %s ESMTP\r\n", *hostname); err != nil {
		return err
	}
	r := bufio.NewReaderSize(conn, 1024)
	for i := 0; i < 10; i++ {
		line, err := r.ReadString('\n')
		if err != nil {
			return err
		}
		verb := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(verb, "EHLO"):
			fmt.Fprintf(conn, "250-%s\r\n250 STARTTLS\r\n", *hostname)
		case strings.HasPrefix(verb, "HELO"):
			fmt.Fprintf(conn, "250 %s\r\n", *hostname)
		case verb == "STARTTLS":
			if r.Buffered() > 0 {
				return errors.New("data after STARTTLS") // a client trying to slip commands past the handshake
			}
			_, err := io.WriteString(conn, "220 2.0.0 Ready to start TLS\r\n")
			return err
		case verb == "NOOP" || verb == "RSET":
			io.WriteString(conn, "250 2.0.0 OK\r\n")
		case verb == "QUIT":
			io.WriteString(conn, "221 2.0.0 Bye\r\n")
			return errors.New("quit")
		default:
			io.WriteString(conn, "530 5.7.0 Must issue a STARTTLS command first\r\n")
		}
	}
	return errors.New("no STARTTLS")
}

func admit(ip string) bool {
	perIPMu.Lock()
	defer perIPMu.Unlock()
	if int(open.Load()) >= *maxConns || perIP[ip] >= *maxPerIP {
		return false
	}
	perIP[ip]++
	open.Add(1)
	return true
}

func release(ip string) {
	perIPMu.Lock()
	defer perIPMu.Unlock()
	if perIP[ip]--; perIP[ip] <= 0 {
		delete(perIP, ip)
	}
	open.Add(-1)
}
