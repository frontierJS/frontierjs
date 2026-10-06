function Ie(i,e){let t=String(i);if(typeof e!=="string")throw TypeError("Expected character");let o=0,n=t.indexOf(e);while(n!==-1)o++,n=t.indexOf(e,n+e.length);return o}
export{Ie};
