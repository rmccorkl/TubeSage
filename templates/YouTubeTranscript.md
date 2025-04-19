---
title: "<% tp.user.title %>"
url: "<% tp.user.videoUrl %>"
date: <% tp.date.now() %>
tags: youtube, transcript, <% tp.user.llmTags %>
transcript:  |
<% tp.user.transcript %>
---

# <% tp.user.title %>
![[Literaturenotes.png|banner+small p+ct]]

> [!info] YouTube Video:
> ![Url|400x200](<% tp.user.videoUrl %>)

>[!summary]
>>[!danger] AI :luc_bot: Generated with <% tp.user.llmProvider %>/<% tp.user.llmModel %>
>> <% tp.user.summary %> 

>[!tip] Thoughts while consuming content - As Input to ideas