import urllib.request
import urllib.parse
import json
import re

def search_ddg(query):
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        html = urllib.request.urlopen(req).read().decode('utf-8')
        snippets = re.findall(r'<a class="result__snippet[^>]*>(.*?)</a>', html, re.IGNORECASE | re.DOTALL)
        titles = re.findall(r'<h2 class="result__title">.*?<a[^>]*>(.*?)</a>', html, re.IGNORECASE | re.DOTALL)
        
        for i in range(min(5, len(titles))):
            clean_title = re.sub(r'<[^>]+>', '', titles[i]).strip()
            clean_snippet = re.sub(r'<[^>]+>', '', snippets[i] if i < len(snippets) else '').strip()
            print(f"Title: {clean_title}")
            print(f"Snippet: {clean_snippet}")
            print("-" * 40)
    except Exception as e:
        print(f"Error: {e}")

search_ddg("AI SDK")
