package identity

import (
	"strings"
	"testing"
)

func TestCentralIdentity(t *testing.T) {
	if Name == "" || Binary != Name || Module != "github.com/kmanisk/"+Name || Version == "" || strings.ContainsAny(Name, " /\\") {
		t.Fatal("inconsistent rename metadata")
	}
	if EnvPrefix != "BRIDGE_DEV_" {
		t.Fatal("environment migration requires deliberate compatibility review")
	}
}
