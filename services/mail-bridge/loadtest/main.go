// loadtest: two measurements for the mail bridge (docs/imap-smtp-relay-plan.md, phase 0), run on the bridge's own
// machine against 127.0.0.1 so no port needs to be open.
//
//	loadtest hold -n 1000        opens n IMAP connections, waits for each greeting, and holds them until stopped.
//	                             Watch the bridge's memory meanwhile (its "stats" log line, or ps).
//	loadtest idle -hours 12      signs in (LOADTEST_USER, LOADTEST_PASSWORD), selects INBOX and sits in IDLE the
//	                             way a desktop mail app does, renewing every 25 minutes. Prints one line per
//	                             renewal and fails loudly if the connection is lost.
package main

import (
	"bufio"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// dial opens one IMAP connection and reads its greeting. `from` picks the loopback address to connect from, so many
// test connections don't all count against the bridge's limit for one address; nil leaves it to the system.
func dial(addr, name string, from net.IP) (*tls.Conn, *bufio.Reader, error) {
	dialer := &net.Dialer{Timeout: 20 * time.Second}
	if from != nil {
		dialer.LocalAddr = &net.TCPAddr{IP: from}
	}
	// The certificate isn't checked: this talks to the bridge on the same machine, by IP.
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: name, InsecureSkipVerify: true})
	if err != nil {
		return nil, nil, err
	}
	r := bufio.NewReader(conn)
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	line, err := r.ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "* OK") {
		conn.Close()
		return nil, nil, fmt.Errorf("no greeting: %q %v", line, err)
	}
	conn.SetReadDeadline(time.Time{})
	return conn, r, nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if len(os.Args) < 2 {
		log.Fatal("use: loadtest hold|idle [flags]")
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:993", "the bridge's IMAP address")
	name := fs.String("name", "mail.xstate.com", "TLS server name")
	n := fs.Int("n", 100, "hold: connections to open")
	rate := fs.Int("rate", 20, "hold: connections opened per second")
	hours := fs.Float64("hours", 12, "idle: how long to stay")
	renew := fs.Duration("renew", 25*time.Minute, "idle: how often to leave IDLE and enter it again")
	fs.Parse(os.Args[2:])
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	switch os.Args[1] {
	case "hold":
		var open, failed atomic.Int64
		var mu sync.Mutex
		var conns []*tls.Conn
		tick := time.NewTicker(time.Second / time.Duration(*rate))
		for i := 0; i < *n; i++ {
			<-tick.C
			// 30 connections from each of 127.1.0.1, 127.1.0.2, …
			from := net.IPv4(127, 1, byte(i/30/250), byte(i/30%250+1))
			go func() {
				conn, _, err := dial(*addr, *name, from)
				if err != nil {
					if failed.Add(1) <= 3 {
						log.Printf("failed: %v", err)
					}
					return
				}
				open.Add(1)
				mu.Lock()
				conns = append(conns, conn)
				mu.Unlock()
			}()
		}
		time.Sleep(5 * time.Second)
		log.Printf("holding open=%d failed=%d", open.Load(), failed.Load())
		<-stop
		mu.Lock()
		for _, c := range conns {
			c.Close()
		}
		mu.Unlock()
	case "idle":
		user, password := os.Getenv("LOADTEST_USER"), os.Getenv("LOADTEST_PASSWORD")
		conn, r, err := dial(*addr, *name, nil)
		if err != nil {
			log.Fatal(err)
		}
		expect := func(want string, within time.Duration) string {
			conn.SetReadDeadline(time.Now().Add(within))
			for {
				line, err := r.ReadString('\n')
				if err != nil {
					log.Fatalf("LOST waiting for %q: %v", want, err)
				}
				if strings.HasPrefix(line, want) {
					return strings.TrimSpace(line)
				}
				if strings.Contains(line, " NO ") || strings.Contains(line, " BAD ") {
					log.Fatalf("refused: %s", strings.TrimSpace(line))
				}
			}
		}
		fmt.Fprintf(conn, "a1 LOGIN \"%s\" \"%s\"\r\n", user, password)
		expect("a1 OK", 30*time.Second)
		fmt.Fprint(conn, "a2 SELECT INBOX\r\n")
		expect("a2 OK", 30*time.Second)
		started := time.Now()
		end := started.Add(time.Duration(*hours * float64(time.Hour)))
		log.Printf("idle test started, until %s", end.Format(time.RFC3339))
		for i := 1; time.Now().Before(end); i++ {
			tag := fmt.Sprintf("i%d", i)
			sent := time.Now()
			fmt.Fprintf(conn, "%s IDLE\r\n", tag)
			expect("+ idling", 30*time.Second)
			wake := time.Since(sent)
			select {
			case <-time.After(*renew):
			case <-stop:
				log.Printf("stopped after %s", time.Since(started).Round(time.Second))
				return
			}
			fmt.Fprint(conn, "DONE\r\n")
			expect(tag+" OK", 30*time.Second)
			log.Printf("renewed %d after %s connected; entering IDLE took %s", i, time.Since(started).Round(time.Second), wake.Round(time.Millisecond))
		}
		fmt.Fprint(conn, "z9 LOGOUT\r\n")
		log.Printf("PASSED: connection held for %s", time.Since(started).Round(time.Second))
	default:
		log.Fatal("use: loadtest hold|idle [flags]")
	}
}
