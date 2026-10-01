# Cloudflare Path Router

A reusable Cloudflare Worker for routing independently deployed websites through a custom domain and URL path.

This project is designed for React, Vite, and other static websites that are deployed independently while keeping their original repositories unchanged.

## How It Works

A website can be deployed independently on Cloudflare Workers or another hosting platform.

The routing Worker sits between the public domain and the independently deployed website.

Example:

```text
Browser
   |
   | https://www.example.com/site/
   v
Cloudflare Path Router
   |
   | removes /site
   v
Independent Website
