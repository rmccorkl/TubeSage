---
title: "<% tp.user.title %>"
video_url: "<% tp.user.videoUrl %>"
created: <% tp.date.now() %>
tubesage_version: <% tp.user.version %>
tags: <% tp.user.llmTags %>
transcript:  |
<% tp.user.transcript %>
---

# <% tp.user.title %>
![[Literaturenotes.png|banner+small p+ct]]

> [!tip] Mobile Thumbnail (fallback)
> [![YouTube Thumbnail|400x225](https://img.youtube.com/vi/<% tp.user.videoUrl.match(/(?:youtu\.be\/|v=)([^?&]+)/)[1] %>/hqdefault.jpg)](<% tp.user.videoUrl %>)


> [!info] YouTube Video:
> ![Url|400x200](<% tp.user.videoUrl %>)

>[!summary]
>>[!danger] AI :luc_bot: Generated with <% tp.user.llmProvider %>/<% tp.user.llmModel %>
>> <% tp.user.summary %> 

>[!tip] Thoughts while consuming content - As Input to ideas