package rpc

// The model catalog (catalog.list): every model the engine knows of and how to run each one.
type (
	// Route is one way to run a model: a harness and the id its --model flag takes.
	Route struct {
		Harness string `json:"harness"`
		ID      string `json:"id"`
		Label   string `json:"label"`
		Ready   bool   `json:"ready"`
		Needs   string `json:"needs"`
	}
	Cost struct {
		Input  float64 `json:"input"`
		Output float64 `json:"output"`
	}
	CatalogModel struct {
		Key          string  `json:"key"`
		Provider     string  `json:"provider"`
		ProviderName string  `json:"providerName"`
		Model        string  `json:"model"`
		Name         string  `json:"name"`
		Family       string  `json:"family"`
		Context      int     `json:"context"`
		Output       int     `json:"output"`
		Cost         *Cost   `json:"cost"`
		Reasoning    bool    `json:"reasoning"`
		Tools        bool    `json:"tools"`
		Vision       bool    `json:"vision"`
		OpenWeights  bool    `json:"openWeights"`
		Released     string  `json:"released"`
		Routes       []Route `json:"routes"`
		Runnable     bool    `json:"runnable"`
		Favourite    bool    `json:"favourite"`
		LastUsed     int64   `json:"lastUsed"`
	}
	HarnessInfo struct {
		CLI              string   `json:"cli"`
		Usable           bool     `json:"usable"`
		Error            string   `json:"error"`
		QuotaUtilization *float64 `json:"quotaUtilization"`
		AnyProvider      bool     `json:"anyProvider"`
		Models           int      `json:"models"`
		DefaultModel     string   `json:"defaultModel"`
	}
	ProviderInfo struct {
		ID       string   `json:"id"`
		Name     string   `json:"name"`
		Env      []string `json:"env"`
		KeyVar   string   `json:"keyVar"`
		KeySet   bool     `json:"keySet"`
		BaseURL  string   `json:"baseUrl"`
		Custom   bool     `json:"custom"`
		Hidden   bool     `json:"hidden"`
		Doc      string   `json:"doc"`
		Models   int      `json:"models"`
		Runnable int      `json:"runnable"`
	}
	Catalog struct {
		Models       []CatalogModel `json:"models"`
		Harnesses    []HarnessInfo  `json:"harnesses"`
		Providers    []ProviderInfo `json:"providers"`
		HarnessOrder []string       `json:"harnessOrder"`
		Source       struct {
			From string  `json:"from"`
			At   float64 `json:"at"`
		} `json:"source"`
	}
	// ProvidersFile is providers.toml as the engine reads it.
	ProvidersFile struct {
		Harnesses  []string                  `json:"harnesses"`
		Favourites []string                  `json:"favourites"`
		Providers  map[string]ProviderConfig `json:"providers"`
	}
	ProviderConfig struct {
		Name    string   `json:"name"`
		Env     string   `json:"env"`
		BaseURL string   `json:"baseUrl"`
		Models  []string `json:"models"`
		Hidden  bool     `json:"hidden"`
	}
)
