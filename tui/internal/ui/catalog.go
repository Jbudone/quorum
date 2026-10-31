package ui

import (
	"strings"

	"github.com/jbud/quorum/tui/internal/rpc"
)

// The engine's model catalog, fetched once and shared by every model search.

// ensureCatalog asks the engine for the catalog unless it's here or on its way.
func (a *App) ensureCatalog() {
	if a.catalog != nil || a.catalogAsked {
		return
	}
	a.reloadCatalog(false)
}

// reloadCatalog fetches it again; refresh makes the engine re-ask every harness.
func (a *App) reloadCatalog(refresh bool) {
	a.catalogAsked = true
	params := map[string]any{}
	if a.opts.Mock {
		params["mock"] = true
	}
	if refresh {
		params["refresh"] = true
	}
	a.call("catalog.list", params)
}

func (a *App) getCatalog() *rpc.Catalog { return a.catalog }

// openSearch builds a model search over the shared catalog.
func (a *App) openSearch(allowed []string, harness, model string) *modelSearch {
	a.ensureCatalog()
	return newModelSearch(a.th, a.getCatalog, allowed, harness, model)
}

// starred saves a favourite toggled in a search ("-key" unstars).
func (a *App) starred(f *modelPick) {
	if f == nil {
		return
	}
	key, on := strings.TrimPrefix(f.key, "-"), !strings.HasPrefix(f.key, "-")
	a.call("catalog.favourite", map[string]any{"key": key, "on": on})
	if a.catalog != nil {
		for i := range a.catalog.Models {
			if a.catalog.Models[i].Key == key {
				a.catalog.Models[i].Favourite = on
			}
		}
	}
}

// picked records a model choice, so it shows under Recent next time.
func (a *App) picked(p modelPick) {
	if p.key == "" {
		return
	}
	a.call("catalog.used", map[string]any{"key": p.key})
	if a.catalog != nil {
		for i := range a.catalog.Models {
			if a.catalog.Models[i].Key == p.key {
				a.catalog.Models[i].LastUsed = 1 << 62 // newest; the real time comes with the next reload
			}
		}
	}
}

// catalogResponse takes catalog and provider answers. It reports whether it took the method.
func (a *App) catalogResponse(method string, r rpc.Response) bool {
	switch method {
	case "catalog.list":
		a.catalogAsked = false
		if r.Err != "" {
			a.notify("couldn't load models: " + r.Err)
			return true
		}
		var c rpc.Catalog
		if rpc.DecodeResult(r.Result, &c) == nil {
			a.catalog = &c
		}
		return true
	case "catalog.favourite", "catalog.used":
		if r.Err != "" {
			a.notify(r.Err)
		}
		return true
	case "providers.get", "providers.set", "harnesses.order":
		if r.Err != "" {
			if a.prov != nil {
				a.prov.err = r.Err
			} else {
				a.notify(r.Err)
			}
			return true
		}
		var f rpc.ProvidersFile
		if rpc.DecodeResult(r.Result, &f) == nil && a.prov != nil {
			a.prov.file = &f
		}
		if method != "providers.get" {
			// What runs where may have changed; the next search sees the new catalog.
			a.reloadCatalog(true)
		}
		return true
	}
	return false
}
