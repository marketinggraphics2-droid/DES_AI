import re, sys, html, urllib.request, os, time
from html.parser import HTMLParser

SP = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SP, "site")
os.makedirs(OUT, exist_ok=True)

SKIP_TAGS = {"script", "style", "noscript", "svg", "iframe", "head", "nav", "footer", "form"}
BLOCK = {"p","div","h1","h2","h3","h4","h5","h6","li","br","tr","section","article","header","td","th","table","ul","ol","blockquote"}

class T(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out=[]; self.skip=0; self.title=""; self.in_title=False; self.meta=""
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag in SKIP_TAGS: self.skip+=1
        if tag=="title": self.in_title=True
        if tag=="meta" and a.get("name")=="description": self.meta=a.get("content","")
        if tag in ("h1","h2","h3","h4"): self.out.append("\n\n## " if tag!="h1" else "\n\n# ")
        elif tag=="li": self.out.append("\n- ")
        elif tag in BLOCK: self.out.append("\n")
        if tag=="a" and a.get("href","").startswith(("mailto:","tel:")): self.out.append(" ["+a["href"]+"] ")
    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self.skip: self.skip-=1
        if tag=="title": self.in_title=False
        if tag in BLOCK: self.out.append("\n")
    def handle_data(self, d):
        if self.in_title: self.title+=d
        if self.skip: return
        self.out.append(d)

def fetch(u):
    req=urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0 (DynamIQ chatbot KB scraper)"})
    with urllib.request.urlopen(req, timeout=40) as r: return r.read().decode("utf-8","ignore")

def clean(txt):
    txt=re.sub(r"[ \t\xa0]+"," ",txt)
    txt=re.sub(r" *\n *","\n",txt)
    txt=re.sub(r"\n{3,}","\n\n",txt)
    return txt.strip()

urls=[l.strip().split("\t") for l in open(os.path.join(SP,"urls.tsv"),encoding="utf-8-sig") if l.strip()]
only=sys.argv[1:] or None
for kind,u in urls:
    if only and kind not in only: continue
    slug=u.rstrip("/").split("/")[-1] or "home"
    fn=os.path.join(OUT,f"{kind}__{slug}.txt")
    if os.path.exists(fn): continue
    try:
        h=fetch(u)
        # cut to main content if possible
        m=re.search(r"<main.*?</main>|<div[^>]+id=\"content\".*?<footer",h,re.S)
        body=m.group(0) if m else h
        p=T(); p.feed(h if not m else body)
        head=T(); head.feed(h[:20000])
        text=clean("".join(p.out))
        with open(fn,"w",encoding="utf-8") as f:
            f.write(f"URL: {u}\nTITLE: {head.title.strip()}\nMETA: {head.meta}\n\n{text}\n")
        print("ok",kind,slug,len(text))
    except Exception as e:
        print("FAIL",u,e)
    time.sleep(0.3)
