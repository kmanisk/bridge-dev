// A small official-SDK test client. This helper is not part of the release binary.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}
func main() {
	binary := flag.String("binary", "./bin/bridge-dev", "server binary")
	endpoint := flag.String("url", "", "HTTP MCP endpoint (otherwise stdio)")
	tokenFile := flag.String("token-file", "", "local token file; never a URL token")
	tool := flag.String("tool", "", "tool to call; empty lists tools")
	args := flag.String("args", "{}", "JSON tool arguments")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "bridge-dev-test-client", Version: "1"}, nil)
	var transport mcp.Transport
	if *endpoint == "" {
		cmd := exec.Command(*binary, append([]string{"stdio"}, flag.Args()...)...)
		cmd.Stderr = os.Stderr
		transport = &mcp.CommandTransport{Command: cmd}
	} else {
		b, e := os.ReadFile(*tokenFile)
		check(e)
		transport = &mcp.StreamableClientTransport{Endpoint: *endpoint, HTTPClient: &http.Client{Transport: bearer{strings.TrimSpace(string(b))}}, DisableStandaloneSSE: true}
	}
	s, e := client.Connect(ctx, transport, nil)
	check(e)
	defer s.Close()
	var result any
	if *tool == "" {
		result, e = s.ListTools(ctx, nil)
	} else {
		var input map[string]any
		check(json.Unmarshal([]byte(*args), &input))
		var r *mcp.CallToolResult
		r, e = s.CallTool(ctx, &mcp.CallToolParams{Name: *tool, Arguments: input})
		result = r
		if r != nil && r.IsError {
			b, _ := json.MarshalIndent(r, "", "  ")
			fmt.Println(string(b))
			os.Exit(1)
		}
	}
	check(e)
	b, e := json.MarshalIndent(result, "", "  ")
	check(e)
	fmt.Println(string(b))
}
func check(e error) {
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
