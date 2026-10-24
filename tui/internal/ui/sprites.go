package ui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"

	"github.com/jbud/quorum/tui/internal/theme"
)

// sprite is a small ASCII picture of what the session is about, with a little animation.
type sprite struct {
	id       string
	label    string
	keywords []string
	art      []string
	mini     string // 3 cells wide; stands in for the item in verdict scenes
	fx       string // ambient effect: steam | sparkle | bits | ideas
	drops    string // glyphs that fall into the picture as it builds
}

var sprites = []sprite{
	{id: "burrito", label: "burrito", keywords: []string{"burrito", "burritos", "tortilla", "wrap"}, mini: "(≈)", fx: "steam", drops: "o#~@",
		art: []string{
			`   _____________________`,
			`  /|~~~~~~~~~~~~~~~~~~~|\`,
			` | |~ @ # ~ o @ # ~ o ~| |`,
			`  \|~~~~~~~~~~~~~~~~~~~|/`,
			`   ‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾`,
		}},
	{id: "taco", label: "taco", keywords: []string{"taco", "tacos", "quesadilla", "nachos"}, mini: "(∩)", fx: "steam", drops: "o#~",
		art: []string{
			`    . - ~ ~ ~ - .`,
			`  ,'  o  #  ~  o ',`,
			` /  ~  o  ~  #  ~  \`,
			`(___________________)`,
		}},
	{id: "pizza", label: "pizza", keywords: []string{"pizza", "pizzas", "calzone"}, mini: "/V\\", fx: "steam", drops: "o●▲",
		art: []string{
			`  _____________`,
			` \ o   ●   o  /`,
			`  \   ▲   ●  /`,
			`   \  o   ▲ /`,
			`    \  ●   /`,
			`     \____/`,
		}},
	{id: "burger", label: "burger", keywords: []string{"burger", "burgers", "hamburger", "cheeseburger"}, mini: "(=)", fx: "steam", drops: "o~#",
		art: []string{
			`    ,-"""""""-.`,
			`  ,' ° °  ° °  ',`,
			` (_______________)`,
			`  ~~~~~~~~~~~~~~~~`,
			`  ################`,
			` (_______________)`,
		}},
	{id: "coffee", label: "coffee", keywords: []string{"coffee", "espresso", "latte", "cafe", "tea", "brew"}, mini: "[~]", fx: "steam", drops: "·°",
		art: []string{
			`    ___________`,
			`   |           |__`,
			`   |  ~ ~ ~ ~  |  )`,
			`   |           |_/`,
			`    \_________/`,
			`   ‾‾‾‾‾‾‾‾‾‾‾‾‾‾`,
		}},
	{id: "icecream", label: "ice cream", keywords: []string{"ice cream", "icecream", "gelato", "sundae", "frozen"}, mini: "(Y)", fx: "sparkle", drops: "*·°",
		art: []string{
			`     ,-~~~-.`,
			`   ,'  o  o  ',`,
			`  (  o   *   o )`,
			`   '.  o   .'`,
			`     \ \/ /`,
			`      \  /`,
			`       \/`,
		}},
	{id: "cake", label: "cake", keywords: []string{"cake", "cupcake", "dessert", "pastry", "pie", "cookie", "cookies"}, mini: "[^]", fx: "sparkle", drops: "*·o",
		art: []string{
			`       i  i  i`,
			`      _|__|__|_`,
			`    ,'~~~~~~~~~',`,
			`   |  o  *  o   |`,
			`   |_____________|`,
		}},
	{id: "chocolate", label: "chocolate", keywords: []string{"chocolate", "candy", "cocoa", "truffle", "snickers"}, mini: "▐▌▐", fx: "sparkle", drops: "·*°",
		art: []string{
			`  ____________________`,
			` |  ▄▄▄ |  ▄▄▄ |  ▄▄▄ |`,
			` |  ███ |  ███ |  ███ |`,
			` |______|______|______|`,
			` |  ███ |  ███ |  ███ |`,
			` |______|______|______|`,
		}},
	{id: "ramen", label: "ramen", keywords: []string{"ramen", "noodle", "noodles", "pho", "soup", "stew"}, mini: "(~)", fx: "steam", drops: "~o",
		art: []string{
			`   ~ ~~ ~~~ ~~ ~`,
			` ,-~~~~~~~~~~~~~~-,`,
			`(  o ~~ ~~ o ~~   )`,
			` \  ~~ o ~~ ~~  /`,
			`  '-.________.-'`,
		}},
	{id: "sandwich", label: "sandwich", keywords: []string{"sandwich", "sandwiches", "sub", "panini", "toast"}, mini: "<=>", fx: "steam", drops: "~#o",
		art: []string{
			`  ,-----------,`,
			` (_____________)`,
			`  ~~~~~~~~~~~~~~`,
			`  ##############`,
			` (_____________)`,
		}},
	{id: "donut", label: "donut", keywords: []string{"donut", "donuts", "doughnut", "bagel"}, mini: "(o)", fx: "sparkle", drops: "*·",
		art: []string{
			`     ,-~~~~~-.`,
			`   ,' * . * . ',`,
			`  (  .  (O)  .  )`,
			`   ', * . * . ,'`,
			`     '-~~~~~-'`,
		}},
	{id: "lock", label: "auth", keywords: []string{"auth", "authentication", "authorization", "password", "login", "jwt", "token", "tokens", "session", "sessions", "cookie", "cookies", "oauth", "sso", "security", "encrypt", "secret", "secrets", "credential"}, mini: "[#]", fx: "bits", drops: "01",
		art: []string{
			`      .-"""-.`,
			`     /  .-.  \`,
			`     | (   ) |`,
			`  ,--'-------'--,`,
			`  |     (_)     |`,
			`  |      |      |`,
			`  '-------------'`,
		}},
	{id: "database", label: "database", keywords: []string{"database", "databases", "sql", "postgres", "mysql", "schema", "migration", "query", "queries", "storage", "index", "cache"}, mini: "(=)", fx: "bits", drops: "01",
		art: []string{
			`    ,-~~~~~~~-.`,
			`   (___________)`,
			`   |           |`,
			`   (-----------)`,
			`   |           |`,
			`   (-----------)`,
			`    '-._____.-'`,
		}},
	{id: "server", label: "service", keywords: []string{"server", "servers", "backend", "api", "apis", "endpoint", "endpoints", "service", "services", "microservice", "microservices", "queue", "rpc"}, mini: "[=]", fx: "bits", drops: "01",
		art: []string{
			`  ,-----------------,`,
			`  | [==========] (o)|`,
			`  |-----------------|`,
			`  | [==========] (o)|`,
			`  |-----------------|`,
			`  | [==========] (o)|`,
			`  '-----------------'`,
		}},
	{id: "cloud", label: "cloud", keywords: []string{"cloud", "aws", "gcp", "azure", "deploy", "deployment", "kubernetes", "k8s", "docker", "infra", "infrastructure", "terraform", "serverless"}, mini: "(≈)", fx: "bits", drops: "01",
		art: []string{
			`        .--~~~--.`,
			`    .--(         )--.`,
			`   (                 )`,
			`    '-~-~-~-~-~-~-~-'`,
			`       |  |  |  |`,
		}},
	{id: "bug", label: "bug", keywords: []string{"bug", "bugs", "crash", "crashes", "regression", "flaky", "defect", "error", "errors"}, mini: "}{ ", fx: "sparkle", drops: "!?",
		art: []string{
			`    \   __   /`,
			`     \ /  \ /`,
			`   ---(o  o)---`,
			`     / \/\/ \`,
			`    /  |  |  \`,
		}},
	{id: "rocket", label: "launch", keywords: []string{"launch", "release", "ship", "rollout", "performance", "speed", "fast", "startup", "growth", "scale", "scaling", "latency"}, mini: "^|^", fx: "sparkle", drops: "*·",
		art: []string{
			`       /\`,
			`      /  \`,
			`     | () |`,
			`     |    |`,
			`    /|    |\`,
			`   /_|____|_\`,
			`      /\/\`,
		}},
	{id: "gear", label: "config", keywords: []string{"config", "configuration", "settings", "build", "pipeline", "ci", "tooling", "setup", "refactor", "architecture"}, mini: "{*}", fx: "bits", drops: "·+",
		art: []string{
			`      _  _`,
			`    _| \/ |_`,
			`   |   ()   |`,
			`   |_      _|`,
			`     |_/\_|`,
		}},
	{id: "book", label: "docs", keywords: []string{"docs", "documentation", "guide", "wiki", "readme", "tutorial", "onboarding", "writing"}, mini: "[=]", fx: "sparkle", drops: "·*",
		art: []string{
			`   ,-----.-----.`,
			`  /     /|     \`,
			` | ~~~ / | ~~~  |`,
			` | ~~~/  | ~~~  |`,
			` | ~~ |  | ~~~  |`,
			`  \____|__|____/`,
		}},
	{id: "phone", label: "app", keywords: []string{"mobile", "ios", "android", "app", "apps", "phone", "react native", "swiftui"}, mini: "[]=", fx: "bits", drops: "·+",
		art: []string{
			`    ,-------,`,
			`    | ,---, |`,
			`    | |   | |`,
			`    | |   | |`,
			`    | '---' |`,
			`    |  (_)  |`,
			`    '-------'`,
		}},
	{id: "bulb", label: "idea", fx: "ideas", mini: "(!)", drops: "*·",
		art: []string{
			`      .-"""-.`,
			`     /  ~ ~  \`,
			`    |  ~ _ ~  |`,
			`     \  ( )  /`,
			`      '-. .-'`,
			`        |_|`,
		}},
}

// spriteFor picks the picture for a topic by keyword; the lightbulb stands in when nothing fits.
func spriteFor(topic string) *sprite {
	t := " " + strings.ToLower(topic) + " "
	words := strings.FieldsFunc(strings.ToLower(topic), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	})
	have := map[string]bool{}
	for _, w := range words {
		have[w] = true
	}
	best, bestScore := -1, 0
	for i, sp := range sprites {
		score := 0
		for _, k := range sp.keywords {
			if strings.Contains(k, " ") {
				if strings.Contains(t, " "+k+" ") || strings.Contains(t, k) {
					score += 2
				}
			} else if have[k] {
				score += 2
			}
		}
		if score > bestScore {
			best, bestScore = i, score
		}
	}
	if best < 0 {
		return &sprites[len(sprites)-1]
	}
	return &sprites[best]
}

func (sp *sprite) width() int {
	w := 0
	for _, r := range sp.art {
		w = max(w, len([]rune(r)))
	}
	return w
}

const artTicks = 90 // ticks the picture animates before settling

const artPad = 3 // blank rows above the picture for falling pieces and steam

// renderSprite draws the topic picture at tick t: pieces fall into it as it builds, then steam,
// sparkles or bits drift around it.
func renderSprite(sp *sprite, topic string, width int, th theme.Theme, t int, anim bool) string {
	return renderSpriteLoop(sp, topic, width, th, t, anim, false)
}

// renderSpriteLoop is renderSprite that can repeat its ambient motion indefinitely (the splash).
func renderSpriteLoop(sp *sprite, topic string, width int, th theme.Theme, t int, anim, loop bool) string {
	w := sp.width()
	head := fg(th.Accent2).Bold(true).Render("◆ TOPIC") + fg(th.Text).Bold(true).Render("  "+sp.label) +
		fg(th.Muted).Render("  "+ansi.Truncate(topic, max(width-len(sp.label)-14, 8), "…"))
	if width < w+8 {
		return ansi.Truncate(head, width, "…")
	}
	if !anim {
		t = 1 << 20
	}
	if anim && loop && t >= artTicks { // keep the ambient motion going while we wait
		t = 24 + (t-24)%(artTicks-24)
	}
	h := artPad + len(sp.art)
	cv := newCanvas(w+8, h)
	rows := len(sp.art)

	// The picture builds from the bottom up (the top rows are drawn last, as if filled).
	built := rows
	if anim {
		built = min(rows, t/3+1)
	}
	for i := rows - built; i < rows; i++ {
		col := th.Speaker((i + len(sp.id)) % 6)
		cv.put(artPad+i, 4, sp.art[i], col, i == rows-built)
	}

	// Pieces drop in while it builds.
	drops := []rune(sp.drops)
	if anim && t < 28 && len(drops) > 0 {
		for i := 0; i < 9; i++ {
			e := t - i*2
			if e < 0 || e > 8 {
				continue
			}
			x := 4 + 3 + int(hash32(i, 7)%uint32(max(w-6, 1)))
			y := e * (artPad + 1) / 8
			cv.put(min(y, artPad), x, string(drops[int(hash32(i, 3))%len(drops)]), th.Warn, true)
		}
	}

	// Ambient motion once built, for a while.
	if anim && t >= 24 && t < artTicks {
		a := t - 24
		switch sp.fx {
		case "steam":
			for k := 0; k < 3; k++ {
				x := 4 + w/4 + k*w/4
				y := 2 - ((a/3 + k) % 3)
				cv.put(y, x+((a/4+k)%2), []string{"~", ")", "("}[(a/2+k)%3], th.Subtle, false)
			}
		case "sparkle":
			for k := 0; k < 4; k++ {
				if (a/3+k)%4 == 0 {
					x := 3 + int(hash32(k, a/6)%uint32(w+2))
					y := int(hash32(k, a/6+1) % uint32(h))
					cv.put(y, x, []string{"✦", "✧", "·"}[(a+k)%3], th.Warn, true)
				}
			}
		case "bits":
			for k := 0; k < 5; k++ {
				x := 4 + int(hash32(k, 11)%uint32(w))
				y := (a/2 + k*2) % (artPad + 1)
				cv.put(y, x, []string{"0", "1"}[(a/3+k)%2], th.OK, false)
			}
		case "ideas":
			for k := 0; k < 3; k++ {
				if (a/4+k)%3 == 0 {
					cv.put(0, 4+w/2+(k-1)*4, "✦", th.Warn, true)
				}
			}
		}
	}
	return head + "\n" + cv.render()
}

// itemGlyph is what the figure holds in verdict scenes.
func itemGlyph(sp *sprite) string {
	if sp == nil || sp.mini == "" {
		return "▬"
	}
	return sp.mini
}
