const q = 'best practices monitoring dashboard UI logs terminal severity filters health cards examples';
fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {headers:{'User-Agent':'Mozilla/5.0'}})
.then(r => r.text())
.then(t => {
  const results = [];
  const regex = /<h2 class="result__title">[\s\S]*?<a[^>]+href="[^"]*?uddg=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = regex.exec(t)) !== null) {
    if (results.length >= 5) break;
    results.push({
      url: decodeURIComponent(m[1]),
      title: m[2].replace(/<[^>]+>/g, '').trim(),
      snippet: m[3].replace(/<[^>]+>/g, '').trim()
    });
  }
  console.log(results);
})
.catch(console.error);
