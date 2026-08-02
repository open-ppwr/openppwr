// The version a page shows must come from the running deployment, not from a content file. The site
// displayed "Community 0.1.0-beta.1" for weeks while the deployment moved through a dozen commits,
// because the only version a visitor could see was the one nobody was updating.
//
// The fetch is unauthenticated and the body is read on every path, including failure: an unread body
// leaves the request open in the browser and the page never settles.
import { useEffect, useState } from 'react';

export function useBuildInfo(){
  const [build,setBuild]=useState(null);
  useEffect(()=>{
    let active=true;
    fetch('/v1/version').then(async(response)=>{
      const text=await response.text();
      if(!response.ok)return null;
      try{return JSON.parse(text);}catch{return null;}
    }).then((body)=>{if(active&&body?.version)setBuild(body);}).catch(()=>{});
    return()=>{active=false;};
  },[]);
  return build;
}

const channelLabels={
  en:{'private-release-candidate':'Private release candidate',beta:'Beta',stable:'Stable'},
  pl:{'private-release-candidate':'Prywatny kandydat wydania',beta:'Beta',stable:'Wersja stabilna'},
  de:{'private-release-candidate':'Privater Release-Kandidat',beta:'Beta',stable:'Stabil'},
};

// "Community 0.1.0-beta.1" alone tells a reader nothing about which build they are looking at. The
// short revision is what makes the claim checkable, so it is shown wherever the version is shown.
export function editionLabel(build,fallback){
  if(!build)return fallback;
  return `Community ${build.version}`;
}

export function buildLabel(build,locale='en'){
  if(!build)return null;
  const channel=channelLabels[locale]?.[build.channel]||channelLabels.en[build.channel]||build.channel;
  return `Build ${build.revisionShort} · ${channel}`;
}
