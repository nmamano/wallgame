export default function (eleventyConfig) {
  // Add date filter
  eleventyConfig.addFilter("date", function (date) {
    return new Date(date).toLocaleDateString();
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
    },
  };
}
